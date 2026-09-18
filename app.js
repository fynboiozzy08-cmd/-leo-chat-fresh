const cfg = window.LEO_CONFIG || {};
const SUPABASE_URL = cfg.SUPABASE_URL;
const SUPABASE_KEY = cfg.SUPABASE_KEY;

const app = document.getElementById("app");

let supabase = null;
let currentUser = null;
let currentProfile = null;
let people = [];
let selectedPerson = null;
let messages = [];
let messageChannel = null;
let peopleTimer = null;
let selectedMedia = null;

function configured() {
  return !!SUPABASE_URL &&
    !!SUPABASE_KEY &&
    !SUPABASE_KEY.includes("PASTE_YOUR");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function render(html) {
  app.innerHTML = html;
}

function showConfigError() {
  render(`
    <main class="screen center">
      <div class="brand">🦁</div>
      <h1>Leo Chat</h1>
      <p class="muted">Fresh web version</p>
      <div class="card error-card">
        <h2>One setup step</h2>
        <p>Add your Supabase <b>publishable</b> key to <code>config.js</code>.</p>
        <p class="muted small">This fresh version does not use the old GitHub configuration.</p>
      </div>
    </main>
  `);
}

async function boot() {
  try {
    if (!configured()) {
      showConfigError();
      return;
    }

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      render(`<main class="screen center"><div class="brand">🦁</div><h1>Leo Chat</h1><div class="card error-card"><h2>Leo Chat could not start</h2><p>The Supabase web library did not load.</p><p class="muted small">Refresh this page. If it still happens, check that JavaScript/CDN access is enabled.</p></div></main>`);
      return;
    }

    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Never leave the user stuck on Loading if the browser cannot
    // complete the Supabase session check.
    const sessionCheck = supabase.auth.getSession();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Supabase session check timed out. The page loaded, but the connection to Supabase did not respond.")), 10000)
    );

    const { data } = await Promise.race([sessionCheck, timeout]);
    currentUser = data?.session?.user || null;

    if (currentUser) {
      await enterApp();
    } else {
      renderWelcome();
    }
  } catch (e) {
    render(`<main class="screen center"><div class="brand">🦁</div><h1>Leo Chat</h1><div class="card error-card"><h2>Startup error</h2><p>${escapeHtml(e?.message || String(e))}</p><button class="outline" onclick="location.reload()">Reload Leo Chat</button></div></main>`);
  }
}

function renderWelcome() {
  render(`
    <main class="screen center">
      <div class="brand">🦁</div>
      <h1>Leo Chat</h1>
      <p class="tagline">Chat. Connect. Roar.</p>

      <div class="auth-card">
        <input id="email" type="email" autocomplete="email" placeholder="Email">
        <input id="password" type="password" autocomplete="current-password" placeholder="Password">
        <button class="gold" id="login">Sign in</button>
        <button class="outline" id="signup">Create account</button>
        <p id="authMsg" class="message"></p>
      </div>
    </main>
  `);

  document.getElementById("login").onclick = () => auth("login");
  document.getElementById("signup").onclick = () => auth("signup");
}

async function auth(mode) {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const msg = document.getElementById("authMsg");

  if (!email || !password) {
    msg.textContent = "Enter your email and password.";
    return;
  }

  msg.textContent = mode === "login" ? "Signing in…" : "Creating account…";

  try {
    let result;
    if (mode === "login") {
      result = await supabase.auth.signInWithPassword({ email, password });
    } else {
      result = await supabase.auth.signUp({ email, password });
    }

    if (result.error) throw result.error;

    if (result.data.session) {
      currentUser = result.data.user;
      await enterApp();
    } else {
      msg.textContent = "Account created. Check your email if confirmation is enabled, then sign in.";
    }
  } catch (e) {
    msg.textContent = e.message || "Authentication failed.";
  }
}

async function enterApp() {
  const profileResult = await supabase
    .from("profiles")
    .select("id,username,display_name,avatar,created_at")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (profileResult.error) {
    renderDbError(profileResult.error.message);
    return;
  }

  currentProfile = profileResult.data;

  if (!currentProfile) {
    renderProfile(true);
    return;
  }

  await loadPeople();
  renderHome();
  startPeopleRefresh();
}

async function loadPeople() {
  const result = await supabase
    .from("profiles")
    .select("id,username,display_name,avatar,created_at")
    .neq("id", currentUser.id)
    .order("created_at", { ascending: true });

  if (!result.error) people = result.data || [];
}

function renderDbError(message) {
  render(`
    <main class="screen center">
      <div class="brand">🦁</div>
      <h1>Leo Chat</h1>
      <div class="card error-card">
        <h2>Supabase connection problem</h2>
        <p>${escapeHtml(message)}</p>
        <button class="outline" onclick="location.reload()">Try again</button>
      </div>
    </main>
  `);
}

function renderProfile(firstTime = false) {
  render(`
    <main class="screen">
      <section class="topbar">
        <h2>${firstTime ? "Create Your Profile" : "Edit Profile"}</h2>
      </section>
      <section class="profile-form">
        <div class="avatar-big" id="avatarPreview">🦁</div>
        <div class="avatar-row">
          ${["🦁","🐯","🐺","🦊","🐼","🐻"].map(x =>
            `<button class="avatar-choice" data-avatar="${x}">${x}</button>`).join("")}
        </div>
        <input id="displayName" placeholder="Display name" value="${escapeHtml(currentProfile?.display_name || "")}">
        <input id="username" placeholder="Username" autocapitalize="none" value="${escapeHtml(currentProfile?.username || "")}">
        <button class="gold" id="saveProfile">Save Profile</button>
        ${!firstTime ? `<button class="outline" id="cancelProfile">Cancel</button>` : ""}
        <p id="profileMsg" class="message"></p>
      </section>
    </main>
  `);

  let chosenAvatar = currentProfile?.avatar || "🦁";
  document.getElementById("avatarPreview").textContent = chosenAvatar;

  document.querySelectorAll(".avatar-choice").forEach(btn => {
    btn.onclick = () => {
      chosenAvatar = btn.dataset.avatar;
      document.getElementById("avatarPreview").textContent = chosenAvatar;
    };
  });

  document.getElementById("saveProfile").onclick = async () => {
    const display_name = document.getElementById("displayName").value.trim();
    const username = document.getElementById("username").value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const msg = document.getElementById("profileMsg");

    if (!display_name || !username) {
      msg.textContent = "Enter a display name and username.";
      return;
    }

    const payload = {
      id: currentUser.id,
      display_name,
      username,
      avatar: chosenAvatar
    };

    const result = currentProfile
      ? await supabase.from("profiles").update(payload).eq("id", currentUser.id).select().single()
      : await supabase.from("profiles").insert(payload).select().single();

    if (result.error) {
      msg.textContent = result.error.message;
      return;
    }

    currentProfile = result.data;
    await loadPeople();
    renderHome();
  };

  const cancel = document.getElementById("cancelProfile");
  if (cancel) cancel.onclick = renderHome;
}

function renderHome() {
  render(`
    <main class="app-shell">
      <header class="app-header">
        <div>
          <h1>Leo Chat 🦁</h1>
          <p>${escapeHtml(currentProfile?.display_name || "Welcome")}</p>
        </div>
        <div class="header-actions">
          <button class="icon-btn" id="refresh">↻</button>
          <button class="icon-btn" id="settings">⚙️</button>
        </div>
      </header>

      <section class="people-list" id="peopleList">
        ${people.length ? people.map(personRow).join("") : `
          <div class="empty">
            <div>🦁</div>
            <h3>No other Leo users yet</h3>
            <p>Create another Leo account to start chatting.</p>
          </div>
        `}
      </section>

      <nav class="bottom-nav">
        <button class="active">💬<span>Chats</span></button>
        <button onclick="renderPlaceholder('Moments','✨')">✨<span>Moments</span></button>
        <button onclick="renderPlaceholder('Calls','📞')">📞<span>Calls</span></button>
        <button id="settings2">⚙️<span>Settings</span></button>
      </nav>
    </main>
  `);

  document.getElementById("refresh").onclick = async () => {
    await loadPeople();
    renderHome();
  };
  document.getElementById("settings").onclick = renderSettings;
  document.getElementById("settings2").onclick = renderSettings;

  document.querySelectorAll("[data-person]").forEach(el => {
    el.onclick = () => openChat(el.dataset.person);
  });
}

function personRow(person) {
  return `
    <button class="person-row" data-person="${person.id}">
      <div class="person-avatar">${escapeHtml(person.avatar || "🦁")}</div>
      <div class="person-info">
        <strong>${escapeHtml(person.display_name)}</strong>
        <span>@${escapeHtml(person.username)}</span>
        <small>Leo user</small>
      </div>
      <span class="chevron">›</span>
    </button>
  `;
}

async function openChat(personId) {
  selectedPerson = people.find(p => p.id === personId);
  if (!selectedPerson) return;
  await loadMessages();
  renderChat();
  subscribeChat();
}

async function loadMessages() {
  const result = await supabase
    .from("messages")
    .select("id,sender_id,receiver_id,message,created_at")
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedPerson.id}),and(sender_id.eq.${selectedPerson.id},receiver_id.eq.${currentUser.id})`)
    .order("created_at", { ascending: true });

  if (!result.error) messages = result.data || [];
}

function renderChat() {
  render(`
    <main class="app-shell chat-shell">
      <header class="chat-header">
        <button class="back" id="back">‹</button>
        <div class="person-avatar">${escapeHtml(selectedPerson.avatar || "🦁")}</div>
        <div class="chat-title">
          <strong>${escapeHtml(selectedPerson.display_name)}</strong>
          <span>@${escapeHtml(selectedPerson.username)}</span>
        </div>
        <button class="icon-btn" onclick="alert('Voice calling will be added to the calling module.')">📞</button>
        <button class="icon-btn" onclick="alert('Video calling will be added to the calling module.')">🎥</button>
      </header>

      <section class="chat-messages" id="chatMessages">
        ${messages.length ? messages.map(messageBubble).join("") : `
          <div class="empty-chat"><div>🦁</div><p>Start the conversation.</p></div>
        `}
      </section>

      <div id="mediaPreview"></div>

      <form class="composer" id="composer">
        <button type="button" class="attach" id="attach">📎</button>
        <input id="messageInput" placeholder="Message" autocomplete="off">
        <button type="submit" class="send">➤</button>
      </form>

      <div class="attach-sheet hidden" id="attachSheet">
        <button id="pickPhoto">🖼️ Photos</button>
        <button id="pickVideo">🎥 Video</button>
        <button id="sendLocation">📍 Location</button>
        <button id="closeAttach">Cancel</button>
      </div>
    </main>
  `);

  document.getElementById("back").onclick = closeChat;
  document.getElementById("composer").onsubmit = sendMessage;
  document.getElementById("attach").onclick = () => document.getElementById("attachSheet").classList.remove("hidden");
  document.getElementById("closeAttach").onclick = () => document.getElementById("attachSheet").classList.add("hidden");
  document.getElementById("pickPhoto").onclick = () => pickMedia("image/*");
  document.getElementById("pickVideo").onclick = () => pickMedia("video/*");
  document.getElementById("sendLocation").onclick = sendLocation;

  scrollChat();
}

function messageBubble(item) {
  const mine = item.sender_id === currentUser.id;
  return `
    <div class="bubble ${mine ? "mine" : "theirs"}">
      <div>${escapeHtml(item.message)}</div>
      ${mine ? `<small>✓✓</small>` : ""}
    </div>
  `;
}

function scrollChat() {
  const el = document.getElementById("chatMessages");
  if (el) el.scrollTop = el.scrollHeight;
}

function closeChat() {
  unsubscribeChat();
  selectedPerson = null;
  messages = [];
  selectedMedia = null;
  renderHome();
}

function subscribeChat() {
  unsubscribeChat();
  messageChannel = supabase
    .channel(`leo-chat-${currentUser.id}-${selectedPerson.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      async payload => {
        if (!selectedPerson) return;
        const m = payload.new || {};
        if (
          (m.sender_id === currentUser.id && m.receiver_id === selectedPerson.id) ||
          (m.sender_id === selectedPerson.id && m.receiver_id === currentUser.id)
        ) {
          await loadMessages();
          renderChat();
          subscribeChat();
        }
      }
    )
    .subscribe();
}

function unsubscribeChat() {
  if (messageChannel) {
    supabase.removeChannel(messageChannel);
    messageChannel = null;
  }
}

async function sendMessage(event) {
  event.preventDefault();

  const input = document.getElementById("messageInput");
  const text = input.value.trim();

  if (!text && !selectedMedia) return;

  let outgoing = text;
  if (selectedMedia?.type === "image") outgoing = text ? `📷 Photo\n${text}` : "📷 Photo";
  if (selectedMedia?.type === "video") outgoing = text ? `🎥 Video\n${text}` : "🎥 Video";

  const result = await supabase.from("messages").insert({
    sender_id: currentUser.id,
    receiver_id: selectedPerson.id,
    message: outgoing
  });

  if (result.error) {
    alert(result.error.message);
    return;
  }

  input.value = "";
  selectedMedia = null;
  document.getElementById("mediaPreview").innerHTML = "";
  await loadMessages();
  renderChat();
  subscribeChat();
}

function pickMedia(accept) {
  document.getElementById("attachSheet").classList.add("hidden");

  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = false;

  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;

    selectedMedia = {
      type: file.type.startsWith("video/") ? "video" : "image",
      file
    };

    document.getElementById("mediaPreview").innerHTML = `
      <div class="media-preview">
        <span>${selectedMedia.type === "image" ? "🖼️ Photo selected" : "🎥 Video selected"}</span>
        <button type="button" id="removeMedia">×</button>
      </div>
    `;
    document.getElementById("removeMedia").onclick = () => {
      selectedMedia = null;
      document.getElementById("mediaPreview").innerHTML = "";
    };
  };

  input.click();
}

async function sendLocation() {
  document.getElementById("attachSheet").classList.add("hidden");
  const result = await supabase.from("messages").insert({
    sender_id: currentUser.id,
    receiver_id: selectedPerson.id,
    message: "📍 Location"
  });
  if (result.error) alert(result.error.message);
  else {
    await loadMessages();
    renderChat();
    subscribeChat();
  }
}

function renderSettings() {
  render(`
    <main class="app-shell">
      <header class="simple-header"><h1>Settings ⚙️</h1></header>
      <section class="settings">
        <button class="setting-row" id="profileEdit">👤 <span><b>Profile</b><small>${escapeHtml(currentProfile?.display_name || "")}</small></span>›</button>
        <button class="setting-row" onclick="alert('Privacy controls will be added to the privacy module.')">🔐 <span><b>Privacy & Security</b><small>Control your privacy</small></span>›</button>
        <button class="setting-row" onclick="alert('Browser notifications require permission and will be connected in the notification module.')">🔔 <span><b>Notifications</b><small>Messages and alerts</small></span>›</button>
        <button class="setting-row logout" id="logout">🚪 <span><b>Log Out</b><small>Sign out of this Leo Chat account</small></span></button>
      </section>
      <nav class="bottom-nav">
        <button onclick="renderHome()">💬<span>Chats</span></button>
        <button onclick="renderPlaceholder('Moments','✨')">✨<span>Moments</span></button>
        <button onclick="renderPlaceholder('Calls','📞')">📞<span>Calls</span></button>
        <button class="active">⚙️<span>Settings</span></button>
      </nav>
    </main>
  `);

  document.getElementById("profileEdit").onclick = () => renderProfile(false);
  document.getElementById("logout").onclick = logout;
}

async function logout() {
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  people = [];
  unsubscribeChat();
  if (peopleTimer) clearInterval(peopleTimer);
  renderWelcome();
}

function renderPlaceholder(title, icon) {
  render(`
    <main class="app-shell">
      <header class="simple-header"><h1>${icon} ${title}</h1></header>
      <section class="placeholder"><div>${icon}</div><h2>Leo ${title}</h2><p>This module is ready for the next build stage.</p></section>
      <nav class="bottom-nav">
        <button onclick="renderHome()">💬<span>Chats</span></button>
        <button onclick="renderPlaceholder('Moments','✨')">✨<span>Moments</span></button>
        <button onclick="renderPlaceholder('Calls','📞')">📞<span>Calls</span></button>
        <button onclick="renderSettings()">⚙️<span>Settings</span></button>
      </nav>
    </main>
  `);
}

function startPeopleRefresh() {
  if (peopleTimer) clearInterval(peopleTimer);
  peopleTimer = setInterval(async () => {
    if (!currentUser || selectedPerson) return;
    await loadPeople();
  }, 10000);
}


window.addEventListener("error", (event) => {
  if (!app || app.innerHTML.trim()) return;
  render(`<main class="screen center"><div class="brand">🦁</div><h1>Leo Chat</h1><div class="card error-card"><h2>Leo Chat could not start</h2><p>${escapeHtml(event.message || "JavaScript error")}</p><button class="outline" onclick="location.reload()">Reload Leo Chat</button></div></main>`);
});

window.addEventListener("unhandledrejection", (event) => {
  if (!app || app.innerHTML.trim()) return;
  render(`<main class="screen center"><div class="brand">🦁</div><h1>Leo Chat</h1><div class="card error-card"><h2>Leo Chat could not start</h2><p>${escapeHtml(event.reason?.message || String(event.reason || "Unknown error"))}</p><button class="outline" onclick="location.reload()">Reload Leo Chat</button></div></main>`);
});

boot();

