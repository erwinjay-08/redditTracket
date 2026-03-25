import os
import argparse
import praw
import time
from collections import defaultdict
from datetime import datetime
import pytz

# ---------- helpers ----------

def hour_to_ampm(hour):
    return datetime.strptime(str(hour), "%H").strftime("%I:%p").lstrip("0")

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

def analyze(posts, tz, label):
    by_day = defaultdict(lambda: defaultdict(int))

    for p in posts:
        dt = datetime.fromtimestamp(p.created_utc, tz)
        day = dt.strftime("%A")
        hour = dt.hour
        by_day[day][hour] += (p.score + p.num_comments)

    print(f"\n=== Best Posting Windows ({label}) ===\n")

    for day in ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]:
        if day not in by_day:
            continue

        hours = by_day[day]
        max_score = max(hours.values())
        ranked = sorted(hours.items(), key=lambda x: x[1], reverse=True)[:3]

        parts = []
        for hour, score in ranked:
            parts.append(f"{hour_to_ampm(hour)} — {score_to_stars(score, max_score)}")

        print(f"{day}: " + " | ".join(parts))

# ---------- main ----------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sub", required=True)
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--tz", default="America/Los_Angeles")
    args = parser.parse_args()

    # 🔐 AUTH — THIS IS THE IMPORTANT FIX
    reddit = praw.Reddit(
        client_id=os.getenv("REDDIT_CLIENT_ID"),
        client_secret=os.getenv("REDDIT_CLIENT_SECRET"),
        username=os.getenv("REDDIT_USERNAME"),
        password=os.getenv("REDDIT_PASSWORD"),
        user_agent=os.getenv("REDDIT_USER_AGENT")
    )

    tz = pytz.timezone(args.tz)
    now = time.time()
    week_cutoff = now - 7 * 24 * 3600
    month_cutoff = now - 30 * 24 * 3600

    sub = reddit.subreddit(args.sub)

    week_posts = []
    month_posts = []

    for post in sub.new(limit=args.limit):
        if post.created_utc >= month_cutoff:
            month_posts.append(post)
            if post.created_utc >= week_cutoff:
                week_posts.append(post)

    print(f"\nSubreddit: r/{args.sub}")
    print(f"Timezone: {args.tz}")
    print(f"Posts scanned: {len(month_posts)} (month), {len(week_posts)} (week)")

    analyze(week_posts, tz, "Last 7 Days")
    analyze(month_posts, tz, "Last 30 Days")

if __name__ == "__main__":
    main()