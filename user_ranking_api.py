# user_ranking_api.py
import os
from collections import defaultdict
from flask import Flask, request, jsonify
import praw

app = Flask(__name__)

def score_to_stars(score, max_score):
    if max_score == 0:
        return "⭐"
    ratio = score / max_score
    if ratio >= 0.85: return "⭐⭐⭐⭐⭐"
    elif ratio >= 0.65: return "⭐⭐⭐⭐"
    elif ratio >= 0.45: return "⭐⭐⭐"
    elif ratio >= 0.25: return "⭐⭐"
    else: return "⭐"

def fetch_user_ranking(username, limit=1000):
    reddit = praw.Reddit(
        client_id=os.getenv("REDDIT_CLIENT_ID"),
        client_secret=os.getenv("REDDIT_CLIENT_SECRET"),
        username=os.getenv("REDDIT_USERNAME"),
        password=os.getenv("REDDIT_PASSWORD"),
        user_agent=os.getenv("REDDIT_USER_AGENT", "reddit-user-analysis-script")
    )

    subreddit_scores = defaultdict(int)
    try:
        user = reddit.redditor(username)
        for submission in user.submissions.new(limit=limit):
            subreddit = submission.subreddit.display_name
            score = submission.score + submission.num_comments
            subreddit_scores[subreddit] += score
    except Exception as e:
        return {"error": str(e)}

    if not subreddit_scores:
        return {"error": "No posts found"}

    max_score = max(subreddit_scores.values())
    ranked = sorted(subreddit_scores.items(), key=lambda x: x[1], reverse=True)
    
    result = []
    for sub, score in ranked:
        result.append({
            "subreddit": sub,
            "score": score,
            "stars": score_to_stars(score, max_score)
        })
    return result

@app.route("/user-ranking")
def user_ranking():
    username = request.args.get("user")
    limit = int(request.args.get("limit", 100))
    if not username:
        return jsonify({"error": "Missing user parameter"}), 400
    data = fetch_user_ranking(username, limit)
    return jsonify({"data": data})

if __name__ == "__main__":
    app.run(debug=True, port=3001)