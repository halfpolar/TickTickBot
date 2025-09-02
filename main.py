from __future__ import annotations
from flask import Flask, request, jsonify, abort, render_template
from datetime import datetime
import sqlite3
from typing import Optional, Dict, Any
import openai
import os
import re

try:
    from dateutil import parser as dateparser
except ImportError:
    print("dateutil not installed. Run: pip install python-dateutil")
    dateparser = None

DB_PATH = "tasks.db"
openai.api_key = os.getenv("OPENAI_API_KEY")

app = Flask(__name__, static_folder="static", template_folder="templates")
last_deleted_task: Optional[Dict[str, Any]] = None

# ===== Database helpers =====
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                description TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                reminder TEXT
            )
        """)
    print("✅ Database initialized")

def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "description": row["description"],
        "completed": bool(row["completed"]),
        "reminder": row["reminder"]
    }

def iso_or_none(value: Optional[str]) -> Optional[str]:
    if not value or value.lower() == "null":
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except Exception:
        try:
            dt = datetime.strptime(value, "%Y-%m-%dT%H:%M")
            return dt.isoformat()
        except Exception:
            abort(400, description="Invalid reminder format.")

# ===== Error Handlers =====
@app.errorhandler(400)
def bad_request(e):
    return jsonify({"ok": False, "error": "bad_request", "message": getattr(e, "description", str(e))}), 400

@app.errorhandler(404)
def not_found(e):
    return jsonify({"ok": False, "error": "not_found", "message": "Resource not found"}), 404

@app.errorhandler(500)
def server_error(e):
    return jsonify({"ok": False, "error": "server_error", "message": "Something went wrong"}), 500

# ===== UI =====
@app.get("/")
def home():
    return render_template("index.html")

# ===== Tasks API =====
@app.post("/tasks")
def create_task():
    data = request.get_json(silent=True) or request.form or {}
    desc = (data.get("description") or "").strip()
    if not desc:
        abort(400, description="description is required")
    reminder = iso_or_none(data.get("reminder"))
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO tasks (description, completed, reminder) VALUES (?, ?, ?)",
            (desc, 0, reminder)
        )
        task_id = cur.lastrowid
        task = row_to_dict(db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
    return jsonify({"ok": True, "task": task}), 201

@app.get("/tasks")
def list_tasks():
    with get_db() as db:
        rows = db.execute("SELECT * FROM tasks ORDER BY id ASC").fetchall()
    return jsonify({"ok": True, "tasks": [row_to_dict(r) for r in rows]}), 200

@app.patch("/tasks/<int:task_id>")
def update_task(task_id: int):
    with get_db() as db:
        row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            abort(404)
        data = request.get_json(silent=True) or request.form or {}
        completed = row["completed"]
        description = row["description"]
        reminder = row["reminder"]

        if "completed" in data:
            completed = 1 if data["completed"] else 0
        if "description" in data and isinstance(data["description"], str):
            desc = data["description"].strip()
            if desc:
                description = desc
        if "reminder" in data:
            reminder = iso_or_none(data["reminder"])

        db.execute(
            "UPDATE tasks SET description=?, completed=?, reminder=? WHERE id=?",
            (description, completed, reminder, task_id)
        )
        updated = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return jsonify({"ok": True, "task": row_to_dict(updated)}), 200

@app.delete("/tasks/<int:task_id>")
def delete_task(task_id: int):
    global last_deleted_task
    with get_db() as db:
        row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            abort(404)
        last_deleted_task = row_to_dict(row)
        db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    return jsonify({"ok": True, "deletedTaskId": task_id}), 200

@app.route("/tasks/reset", methods=["DELETE", "POST"])
def reset_all_tasks():
    global last_deleted_task
    with get_db() as db:
        db.execute("DELETE FROM tasks")
    last_deleted_task = None
    return jsonify({"ok": True, "message": "All tasks cleared"}), 200

@app.post("/tasks/undo-delete")
def undo_delete():
    global last_deleted_task
    if not last_deleted_task:
        return jsonify({"ok": False, "message": "Nothing to undo"}), 200
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO tasks (description, completed, reminder) VALUES (?, ?, ?)",
            (last_deleted_task["description"], int(last_deleted_task["completed"]), last_deleted_task["reminder"])
        )
        restored_id = cur.lastrowid
        restored = db.execute("SELECT * FROM tasks WHERE id=?", (restored_id,)).fetchone()
    last_deleted_task = None
    return jsonify({"ok": True, "task": row_to_dict(restored)}), 200

# ===== Chat/NLP =====
def extract_message_payload() -> str:
    data = request.get_json(silent=True)
    if isinstance(data, dict) and "message" in data:
        return data.get("message", "")
    if request.form and "message" in request.form:
        return request.form.get("message", "")
    return ""

def parse_chat_message(message_raw: str) -> dict:
    message = message_raw.strip()
    if not message:
        return {"function": None, "reply": "Hi! I didn't catch that. Please type something."}

    # Greeting
    if message.lower() in ["hi", "hello", "hey"]:
        reply_text = (
            "Hi! 😊 I can help you manage tasks:\n"
            "1. Add task\n"
            "2. View tasks\n"
            "3. Complete task\n"
            "4. Delete task\n"
            "5. Undo last delete\n"
            "6. Reset all tasks"
        )
        return {"function": None, "reply": reply_text}

    reminder = None
    if dateparser:
        try:
            dt = dateparser.parse(message, fuzzy=True)
            if dt:
                reminder = dt.isoformat()
        except Exception:
            reminder = None

    # Add task
    match = re.match(r"add task (.+)", message, re.IGNORECASE)
    if match:
        return {
            "function": "addTask",
            "arguments": {"description": match.group(1).strip(), "reminder": reminder}
        }

    # View tasks
    if re.search(r"view tasks", message, re.IGNORECASE):
        return {"function": "viewTasks", "arguments": {}}

    # Complete task (user refers to task number shown in UI, not DB id)
    match = re.match(r"complete task (\d+)", message, re.IGNORECASE)
    if match:
        return {"function": "completeTask", "arguments": {"task_number": int(match.group(1))}}

    # Delete task (user refers to task number shown in UI)
    match = re.match(r"delete task (\d+)", message, re.IGNORECASE)
    if match:
        return {"function": "deleteTask", "arguments": {"task_number": int(match.group(1))}}

    # Undo delete
    if re.search(r"undo delete", message, re.IGNORECASE):
        return {"function": "undoDelete", "arguments": {}}

    # Reset all
    if re.search(r"reset tasks", message, re.IGNORECASE):
        return {"function": "resetAll", "arguments": {}}

    return {"function": None, "reply": "I can help with 'add task', 'view tasks', 'complete task', 'delete task', 'undo delete', 'reset tasks'."}

@app.post("/chat")
@app.post("/api/chat")
def chat():
    user_message = extract_message_payload()
    if not user_message:
        abort(400, description="message is required")
    
    action = parse_chat_message(user_message)
    return jsonify({"ok": True, "result": action}), 200

# ===== Run =====
if __name__ == "__main__":
    init_db()
    app.run(debug=True)


