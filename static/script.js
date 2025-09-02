let tasks = [];
let deletedTask = null;
let calendar;

// ===== Utilities =====
function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return alert(msg);
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => el.style.display = "none", 2000);
}

// ===== Load & Render Tasks =====
async function loadTasks() {
  try {
    const res = await fetch("/tasks");
    const data = await res.json();
    tasks = data.tasks || [];
    renderTasks();
    renderCalendar();
    updateOverview();
  } catch (err) {
    console.error(err);
    showToast("Failed to load tasks");
  }
}

function renderTasks() {
  const taskList = document.getElementById("taskList");
  taskList.innerHTML = "";

  tasks.sort((a, b) => a.id - b.id);

  tasks.forEach((task, index) => {
    const div = document.createElement("div");
    div.className = "task" + (task.completed ? " completed" : "");

    const reminderDate = task.reminder ? new Date(task.reminder).toLocaleDateString() : "";
    const reminderTime = task.reminder ? new Date(task.reminder).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "";

    div.innerHTML = `
      <div>
        ${index+1}. ${task.description}<br>
        ${reminderDate} ${reminderTime}
      </div>
      <div class="task-buttons">
        <button onclick="toggleComplete(${task.id})">${task.completed ? "✅" : "⭕"}</button>
        <button onclick="editTask(${task.id})">✏️</button>
        <button onclick="deleteTask(${task.id})">🗑️</button>
      </div>
    `;
    taskList.appendChild(div);
  });
}

function updateOverview() {
  document.getElementById("totalTasks").textContent = tasks.length;
  document.getElementById("completedTasks").textContent = tasks.filter(t => t.completed).length;
  document.getElementById("pendingTasks").textContent = tasks.filter(t => !t.completed).length;
}

// ===== Calendar =====
function renderCalendar() {
  calendar.removeAllEvents();
  tasks.forEach(task => {
    if (task.reminder) {
      calendar.addEvent({
        id: String(task.id),
        start: task.reminder,
        display: 'background' // dot only
      });
    }
  });
}

function showDayTasks(dateStr) {
  const dayTasks = tasks.filter(t => t.reminder && t.reminder.startsWith(dateStr));
  const container = document.getElementById("dayTasks");
  container.innerHTML = "";
  dayTasks.forEach((task, i) => {
    const reminderTime = new Date(task.reminder).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const div = document.createElement("div");
    div.textContent = `${i+1}. ${task.description} (${reminderTime})`;
    container.appendChild(div);
  });
}

// ===== CRUD =====
async function addTask(description, reminder = null) {
  if (!description) return;
  try {
    const res = await fetch("/tasks", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({description, reminder})
    });
    const data = await res.json();
    if (data.ok) {
      tasks.push(data.task);
      renderTasks();
      renderCalendar();
      updateOverview();
      showToast("Task added");
    }
  } catch (err) {
    console.error(err);
    showToast("Failed to add task");
  }
}

function addTaskFromUI() {
  const desc = document.getElementById("taskInput").value.trim();
  const date = document.getElementById("dateInput").value;
  const time = document.getElementById("timeInput").value;

  if (!desc) return showToast("Enter task description");

  let reminder = date ? (time ? `${date}T${time}` : `${date}T00:00`) : null;
  addTask(desc, reminder);

  document.getElementById("taskInput").value = "";
  document.getElementById("dateInput").value = "";
  document.getElementById("timeInput").value = "";
}

async function toggleComplete(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  try {
    const res = await fetch(`/tasks/${id}`, {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({completed: !task.completed})
    });
    const data = await res.json();
    if (data.ok) {
      Object.assign(task, data.task);
      renderTasks();
      updateOverview();
    }
  } catch (err) { console.error(err); }
}

async function editTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const newDesc = prompt("Edit task description:", task.description);
  if (newDesc === null) return;
  const newReminder = prompt("Edit reminder (YYYY-MM-DDTHH:MM) or leave blank:", task.reminder ? task.reminder.slice(0,16) : "");
  try {
    const res = await fetch(`/tasks/${id}`, {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({description: newDesc.trim(), reminder: newReminder || null})
    });
    const data = await res.json();
    if (data.ok) {
      Object.assign(task, data.task);
      renderTasks();
      renderCalendar();
      updateOverview();
      showToast("Task updated");
    }
  } catch(err) { console.error(err); }
}

async function deleteTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  deletedTask = {...task};
  try {
    const res = await fetch(`/tasks/${id}`, {method: "DELETE"});
    const data = await res.json();
    if (data.ok) {
      tasks = tasks.filter(t => t.id !== id);
      renderTasks();
      renderCalendar();
      updateOverview();
      showToast("Task deleted");
    }
  } catch(err) { console.error(err); }
}

async function undoDelete() {
  if (!deletedTask) return showToast("Nothing to undo");
  try {
    const res = await fetch("/tasks/undo-delete", {method: "POST"});
    const data = await res.json();
    if (data.ok) {
      tasks.push(data.task);
      renderTasks();
      renderCalendar();
      updateOverview();
      deletedTask = null;
      showToast("Restored last deleted task");
    }
  } catch(err) { console.error(err); }
}

async function resetTasks() {
  if (!confirm("Delete all tasks?")) return;
  try {
    const res = await fetch("/tasks/reset", {method: "DELETE"});
    const data = await res.json();
    if (data.ok) {
      tasks = [];
      renderTasks();
      renderCalendar();
      updateOverview();
      showToast("All tasks cleared");
    }
  } catch(err) { console.error(err); }
}

// ===== Chat =====
function appendMessage(text, who = "ai") {
  const box = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = who;
  div.innerHTML = `<span><strong>${who === "user" ? "You" : "AI"}:</strong> ${text}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ===== Map user-visible task number to real ID =====
function getTaskIdByNumber(number) {
  const idx = number - 1;
  if (idx < 0 || idx >= tasks.length) return null;
  return tasks[idx].id;
}

// ===== Handle AI actions =====
async function handleChatAction(action) {
  if (!action) return;

  if (!action.function) {
    if (action.reply) appendMessage(action.reply, "ai");
    return;
  }

  const fn = action.function;
  const args = action.arguments || {};

  try {
    switch(fn) {
      case "addTask":
        await addTask(args.description, args.reminder);
        appendMessage(`✅ Added task: ${args.description}`, "ai");
        break;

      case "viewTasks":
        if (!tasks.length) appendMessage("📋 No tasks yet.", "ai");
        else tasks.forEach((t,i)=>{
          const date = t.reminder ? new Date(t.reminder).toLocaleDateString() : "";
          const time = t.reminder ? new Date(t.reminder).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : "";
          appendMessage(`${i+1}. ${t.description} ${date} ${time}`, "ai");
        });
        break;

      case "completeTask": {
        const realId = getTaskIdByNumber(args.task_number || args.task_id);
        if (!realId) return appendMessage("⚠️ Invalid task number.", "ai");
        await toggleComplete(realId);
        appendMessage(`✅ Toggled completion of task #${args.task_number || args.task_id}`, "ai");
        break;
      }

      case "deleteTask": {
        const realId = getTaskIdByNumber(args.task_number || args.task_id);
        if (!realId) return appendMessage("⚠️ Invalid task number.", "ai");
        await deleteTask(realId);
        appendMessage(`🗑 Deleted task #${args.task_number || args.task_id}`, "ai");
        break;
      }

      case "undoDelete":
        await undoDelete();
        appendMessage("♻️ Restored last deleted task", "ai");
        break;

      case "resetAll":
        await resetTasks();
        appendMessage("🗑 Cleared all tasks", "ai");
        break;

      default:
        if (action.reply) appendMessage(action.reply, "ai");
    }

    // Update UI after every action
    renderTasks();
    renderCalendar();
    updateOverview();

  } catch(err) {
    console.error(err);
    appendMessage(`⚠️ ${err.message}`, "ai");
  }
}

async function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return;
  appendMessage(msg, "user");
  input.value = "";

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({message: msg})
    });
    const data = await res.json();
    if (!data.ok) return appendMessage("⚠️ Error", "ai");
    await handleChatAction(data.result);
  } catch(err) {
    console.error(err);
    appendMessage("⚠️ Error", "ai");
  }
}

function clearChat() {
  document.getElementById("chatMessages").innerHTML="";
}

// ===== Init =====
document.addEventListener("DOMContentLoaded", ()=>{
  calendar = new FullCalendar.Calendar(document.getElementById("calendar"), {
    initialView: "dayGridMonth",
    dayMaxEventRows: true,
    events: [],
    dateClick: info => showDayTasks(info.dateStr)
  });
  calendar.render();

  document.getElementById("addTaskBtn").onclick = addTaskFromUI;
  document.getElementById("resetBtn").onclick = resetTasks;
  document.getElementById("undoDeleteBtn").onclick = undoDelete;
  document.getElementById("sendChatBtn").onclick = sendMessage;
  document.getElementById("clearChatBtn").onclick = clearChat;

  document.getElementById("taskInput").addEventListener("keypress", e => { if(e.key==="Enter") addTaskFromUI(); });
  document.getElementById("chatInput").addEventListener("keypress", e => { if(e.key==="Enter") sendMessage(); });

  loadTasks();
});
