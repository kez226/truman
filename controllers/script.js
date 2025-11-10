const Script = require('../models/Script.js');
const User = require('../models/User');
const Notification = require('../models/Notification');
const helpers = require('./helpers');
const _ = require('lodash');
const dotenv = require('dotenv');
dotenv.config({ path: '.env' }); // See the file .env.example for the structure of .env

/**
 * GET /
 * Fetch and render newsfeed.
 */
exports.getScript = async (req, res, next) => {
  try {
    const one_day = 86400000;
    const account_created_ms = new Date(req.user.createdAt).getTime();
    const time_diff = Date.now() - account_created_ms;
    const time_limit = time_diff - one_day;

    const user = await User.findById(req.user.id)
      .populate("posts.comments.actor")
      .exec();

    // Normalize createdAt into a real Date
    let createdAtDate;
    if (user.createdAt instanceof Date) {
      createdAtDate = user.createdAt;
    } else if (user.createdAt.$date) {
      createdAtDate = new Date(user.createdAt.$date);
    } else {
      createdAtDate = new Date(user.createdAt);
    }
    const baseTime = createdAtDate.getTime();

    // If the user is no longer active, log them out
    if (!user.active) {
      req.logout((err) => {
        if (err) console.log("Error : Failed to logout.", err);
        req.session.destroy((err) => {
          if (err)
            console.log(
              "Error : Failed to destroy the session during logout.",
              err
            );
          req.user = null;
          req.flash("errors", {
            msg: "Account is no longer active. Study is over.",
          });
          res.redirect(
            "/login" + (req.query.r_id ? `?r_id=${req.query.r_id}` : "")
          );
        });
      });
    }

    const current_day = Math.floor(time_diff / one_day);
    if (current_day < process.env.NUM_DAYS) {
      user.study_days[current_day] += 1;
      user.save();
    }

    const currentCondition = 3; 
    console.log("Hardcoded condition:", currentCondition);

    const script_feed = await Script.find({
      condition: String(currentCondition), // match "1", "2", etc.
      $or: [{ display_time: { $ne: null } }, { time: { $lte: time_diff, $gte: 0 } }],
    })
      .sort({ time: 1 })
      .populate({
        path: "actor",
        select: "username profile",
        populate: { path: "profile", select: "name picture" },
      })
      .populate({
        path: "comments.actor",
        select: "username profile",
        populate: { path: "profile", select: "name picture" },
      })
      .exec();

    // ✅ PRE-COMPUTE display_time server-side for all actor posts + comments
    for (const post of script_feed) {
      if (!post.display_time) {
        const offset = Number(post.time) || 0;
        post.display_time = new Date(baseTime + offset).toLocaleString();
      }

      // ensure comments also get valid timestamps
      if (Array.isArray(post.comments)) {
        post.comments.forEach((c) => {
          if (!c.display_time) {
            const offset = Number(c.time) || 0;
            c.display_time = new Date(baseTime + offset).toLocaleString();
          }
        });
      }
    }

    let user_posts = user.getPostInPeriod(time_limit, time_diff);
    user_posts.sort((a, b) => b.relativeTime - a.relativeTime);

    const finalfeed = helpers.getFeed(
      user_posts,
      script_feed,
      user,
      process.env.FEED_ORDER,
      process.env.REMOVE_FLAGGED_CONTENT == "TRUE",
      true
    );

    console.log("Script Size is now: " + finalfeed.length);
    console.log(`Rendering Condition ${currentCondition} — ${script_feed.length} posts found`);

    // ✅ Nothing for Pug to calculate anymore
    res.render("script", {
      script: finalfeed,
      showNewPostIcon: true,
      userCreatedAt: createdAtDate,
    });
  } catch (err) {
    next(err);
  }
};


/*
 * Post /post/new
 * Record a new user-made post. Include any actor replies (comments) that go along with it.
 */
exports.newPost = async(req, res) => {
    try {
        const user = await User.findById(req.user.id).exec();
        if (req.file) {
            user.numPosts = user.numPosts + 1; // Count begins at 0
            const currDate = Date.now();

            let post = {
                type: "user_post",
                postID: user.numPosts,
                body: req.body.body,
                picture: req.file.filename,
                liked: false,
                likes: 0,
                comments: [],
                absTime: currDate,
                relativeTime: currDate - user.createdAt,
            };

            // Find any Actor replies (comments) that go along with this post
            const actor_replies = await Notification.find({
                    condition: { "$in": ["", user.experimentalCondition] }
                })
                .where('userPostID').equals(post.postID)
                .where('notificationType').equals('reply')
                .populate('actor').exec();

            // If there are Actor replies (comments) that go along with this post, add them to the user's post.
            if (actor_replies.length > 0) {
                for (const reply of actor_replies) {
                    user.numActorReplies = user.numActorReplies + 1; // Count begins at 0
                    const tmp_actor_reply = {
                        actor: reply.actor._id,
                        body: reply.replyBody,
                        commentID: user.numActorReplies,
                        relativeTime: post.relativeTime + reply.time,
                        absTime: new Date(user.createdAt.getTime() + post.relativeTime + reply.time),
                        new_comment: false,
                        liked: false,
                        flagged: false,
                        likes: 0
                    };
                    post.comments.push(tmp_actor_reply);
                }
            }
            user.posts.unshift(post); // Add most recent user-made post to the beginning of the array
            await user.save();
            res.redirect('/');
        } else {
            req.flash('errors', { msg: 'ERROR: Your post did not get sent. Please include a photo and a caption.' });
            res.redirect('/');
        }
    } catch (err) {
        next(err);
    }
};

/**
 * POST /feed/
 * Record user's actions on ACTOR posts. 
 */
exports.postUpdateFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Check if user has interacted with the post before.
        let feedIndex = _.findIndex(user.feedAction, function(o) { return o.post == req.body.postID; });

        // If the user has not interacted with the post before, add the post to user.feedAction.
        if (feedIndex == -1) {
            const cat = {
                post: req.body.postID,
                postCondition: req.body.postCondition,
            };
            feedIndex = user.feedAction.push(cat) - 1;
        }

        // User created a new comment on the post.
        if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                new_comment: true,
                new_comment_id: user.numComments,
                body: req.body.comment_text,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                liked: false,
                flagged: false,
            }
            user.feedAction[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const isUserComment = (req.body.isUserComment == 'true');
            // Check if user has interacted with the comment before.
            let commentIndex = (isUserComment) ?
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.new_comment_id == req.body.commentID && o.new_comment == isUserComment
                }) :
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.comment == req.body.commentID && o.new_comment == isUserComment
                });

            // If the user has not interacted with the comment before, add the comment to user.feedAction[feedIndex].comments
            if (commentIndex == -1) {
                const cat = {
                    comment: req.body.commentID
                };
                user.feedAction[feedIndex].comments.push(cat);
                commentIndex = user.feedAction[feedIndex].comments.length - 1;
            }

            // User liked the comment.
            if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].comments[commentIndex].likeTime.push(like);
                user.feedAction[feedIndex].comments[commentIndex].liked = true;
                if (req.body.isUserComment != 'true') user.numCommentLikes++;
            }

            // User unliked the comment.
            if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].comments[commentIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].comments[commentIndex].liked = false;
                if (req.body.isUserComment != 'true') user.numCommentLikes--;
            }

            // User flagged the comment.
            else if (req.body.flag) {
                const flag = req.body.flag;
                user.feedAction[feedIndex].comments[commentIndex].flagTime.push(flag);
                user.feedAction[feedIndex].comments[commentIndex].flagged = true;
            }

            // User unflagged the comment.
            else if (req.body.unflag) {
                const unflag = req.body.unflag;
                user.feedAction[feedIndex].comments[commentIndex].unflagTime.push(unflag);
                user.feedAction[feedIndex].comments[commentIndex].flagged = false;
            }
        }
        // User interacted with the post.
        else {
            // User flagged the post.
            if (req.body.flag) {
                const flag = req.body.flag;
                user.feedAction[feedIndex].flagTime.push(flag);
                user.feedAction[feedIndex].flagged = true;
            }

            // User unflagged the post.
            else if (req.body.unflag) {
                const unflag = req.body.unflag;
                user.feedAction[feedIndex].unflagTime.push(unflag);
                user.feedAction[feedIndex].flagged = false;
            }

            // User liked the post.
            else if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].likeTime.push(like);
                user.feedAction[feedIndex].liked = true;
                user.numPostLikes++;
            }
            // User unliked the post.
            else if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].liked = false;
                user.numPostLikes--;
            }
            // User read the post.
            else if (req.body.viewed) {
                const view = req.body.viewed;
                user.feedAction[feedIndex].readTime.push(view);
                user.feedAction[feedIndex].rereadTimes++;
                user.feedAction[feedIndex].mostRecentTime = Date.now();
            } else {
                console.log('Something in feedAction went crazy. You should never see this.');
            }
        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /userPost_feed/
 * Record user's actions on USER posts. 
 */
exports.postUpdateUserPostFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Find the index of object in user.posts
        let feedIndex = _.findIndex(user.posts, function(o) { return o.postID == req.body.postID; });

        if (feedIndex == -1) {
            // Should not happen.
        }
        // User created a new comment on the post.
        else if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                body: req.body.comment_text,
                commentID: user.numComments,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                new_comment: true,
                liked: false,
                flagged: false,
                likes: 0
            };
            user.posts[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const commentIndex = _.findIndex(user.posts[feedIndex].comments, function(o) {
                return o.commentID == req.body.commentID && o.new_comment == (req.body.isUserComment == 'true');
            });
            if (commentIndex == -1) {
                console.log("Should not happen.");
            }
            // User liked the comment.
            else if (req.body.like) {
                user.posts[feedIndex].comments[commentIndex].liked = true;
            }
            // User unliked the comment. 
            else if (req.body.unlike) {
                user.posts[feedIndex].comments[commentIndex].liked = false;
            }
            // User flagged the comment.
            else if (req.body.flag) {
                user.posts[feedIndex].comments[commentIndex].flagged = true;
            }
        }
        // User interacted with the post. 
        else {
            // User liked the post.
            if (req.body.like) {
                user.posts[feedIndex].liked = true;
            }
            // User unliked the post.
            if (req.body.unlike) {
                user.posts[feedIndex].liked = false;
            }
        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
}