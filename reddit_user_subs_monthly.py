import os
import argparse
import praw
import time
from collections import defaultdict

def score_to_stars(score, max_score):
    if max_score == 0:
        return "⭐"
    ratio = score / max_score
    if ratio >= 0.85:
        return "⭐⭐⭐⭐⭐"
    elif ratio >= 0.65:
        return "⭐⭐⭐⭐"
    elif ratio >= 0.45:
        return "⭐⭐⭐"
    elif ratio >= 0.25:
        return "⭐⭐"
    else:
        return "⭐"

def main():
    parser = argparse.ArgumentParser(description="Rank subreddits a user performs best in (monthly)")
    parser.add_argument("--user", required=True, help="Reddit username")
    parser.add_argument("--months", type=int, default=1, help="How many months back to scan")
    parser.add_argument("--limit", type=int, default=2000, help="Max submissions to scan")
    args = parser.parse_args()

    reddit = praw.Reddit(
        client_id=os.getenv("REDDIT_CLIENT_ID"),
        client_secret=os.getenv("REDDIT_CLIENT_SECRET"),
        username=os.getenv("REDDIT_USERNAME"),
        password=os.getenv("REDDIT_PASSWORD"),
        user_agent=os.getenv("REDDIT_USER_AGENT", "reddit-user-monthly-analysis")
    )

    cutoff = time.time() - (args.months * 30 * 24 * 3600)

    print(f"\nUser: u/{args.user}")
    print(f"Time window: Last {args.months} month(s)\n")

    subreddit_scores = defaultdict(lambda: {
        "score": 0,
        "posts": 0,
        "upvotes": 0,
        "comments": 0
    })

    user = reddit.redditor(args.user)
    scanned = 0

    for submission in user.submissions.new(limit=args.limit):
        if submission.created_utc < cutoff:
            continue

        sub = submission.subreddit.display_name
        upvotes = submission.score
        comments = submission.num_comments
        total = upvotes + comments

        subreddit_scores[sub]["score"] += total
        subreddit_scores[sub]["posts"] += 1
        subreddit_scores[sub]["upvotes"] += upvotes
        subreddit_scores[sub]["comments"] += comments
        scanned += 1

    if scanned == 0:
        print("No posts found in this time window.")
        return

    max_score = max(v["score"] for v in subreddit_scores.values())
    ranked = sorted(subreddit_scores.items(), key=lambda x: x[1]["score"], reverse=True)

    print("=== Monthly Performance by Subreddit ===\n")
    for sub, data in ranked:
        stars = score_to_stars(data["score"], max_score)
        print(
            f"{stars}  r/{sub:<25} "
            f"Posts: {data['posts']:<3} "
            f"Score: {data['score']:<6} "
            f"(⬆ {data['upvotes']} | 💬 {data['comments']})"
        )

if __name__ == "__main__":
    main()