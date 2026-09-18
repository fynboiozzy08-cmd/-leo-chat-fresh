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

/* =========================================================
   HELPERS
   ========================================================= */

function configured() {
  return (
    !!SUPABASE_URL &&
    !!SUPABASE_KEY &&
    !SUPABASE_KEY.includes("PASTE_YOUR")
  );
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

function render(html) {
  if (app) {
    app.innerHTML = html;
  }
}

function showStartupError(title, message) {
  render(`
    <main class="screen center">
      <div class="brand">🦁</div>
      <h1>Leo Chat</h1>
      <p class="tagline">Chat. Connect. Roar.</p>

      <div class="card error-card">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>

        <button
          class="outline"
          onclick="location.reload()"
        >
          Reload Leo Chat
        </button>
      </div>
    </main>
  `);
}

/*
  Prevent any Supabase request from keeping the app stuck
  forever.
*/
async function withTimeout(promise, milliseconds, message) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
  });

  try {
    return await Promise.race([
      promise,
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   CONFIG ERROR
   ========================================================= */

function showConfigError() {
  showStartupError(
    "Supabase key missing",
    "Add your Supabase publishable key to config.js."
  );
}

/* =========================================================
   STARTUP
   ========================================================= */

async function boot() {
  try {
    render(`
      <main class="screen center">
        <div class="brand">🦁</div>
        <h1>Leo Chat</h1>
        <p class="tagline">Chat. Connect. Roar.</p>
        <p class="muted">Connecting...</p>
      </main>
    `);

    if (!configured()) {
      showConfigError();
      return;
    }

    /*
      Make sure the Supabase browser library actually loaded.
    */
    if (
      !window.supabase ||
      typeof window.supabase.createClient !== "function"
    ) {
      showStartupError(
        "Leo Chat could not start",
        "The Supabase web library did not load. Refresh the page and try again."
      );
      return;
    }

    supabase = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );

    /*
      Give the session request a maximum of 10 seconds.
    */
    const sessionResult = await withTimeout(
      supabase.auth.getSession(),
      10000,
      "Supabase did not respond while checking your session."
    );

    currentUser =
      sessionResult?.data?.session?.user || null;

    if (currentUser) {
      await enterApp();
    } else {
      renderWelcome();
    }
  } catch (error) {
    console.error("Leo Chat startup error:", error);

    showStartupError(
      "Startup error",
      error?.message ||
        "Leo Chat could not finish starting."
    );
  }
}

/* =========================================================
   WELCOME
   ========================================================= */

function renderWelcome() {
  render(`
    <main class="screen center">
      <div class="brand">🦁</div>

      <h1>Leo Chat</h1>

      <p class="tagline">
        Chat. Connect. Roar.
      </p>

      <div class="auth-card">
        <input
          id="email"
          type="email"
          autocomplete="email"
          placeholder="Email"
        >

        <input
          id="password"
          type="password"
          autocomplete="current-password"
          placeholder="Password"
        >

        <button
          class="gold"
          id="login"
        >
          Sign in
        </button>

        <button
          class="outline"
          id="signup"
        >
          Create account
        </button>

        <p
          id="authMsg"
          class="message"
        ></p>
      </div>
    </main>
  `);

  document.getElementById("login").onclick = () =>
    auth("login");

  document.getElementById("signup").onclick = () =>
    auth("signup");
}

/* =========================================================
   AUTH
   ========================================================= */

async function auth(mode) {
  const emailInput =
    document.getElementById("email");

  const passwordInput =
    document.getElementById("password");

  const msg =
    document.getElementById("authMsg");

  const email =
    emailInput?.value.trim() || "";

  const password =
    passwordInput?.value || "";

  if (!email || !password) {
    msg.textContent =
      "Enter your email and password.";
    return;
  }

  msg.textContent =
    mode === "login"
      ? "Signing in..."
      : "Creating account...";

  try {
    let result;

    if (mode === "login") {
      result = await withTimeout(
        supabase.auth.signInWithPassword({
          email,
          password
        }),
        15000,
        "The login request timed out. Check your internet connection and try again."
      );
    } else {
      result = await withTimeout(
        supabase.auth.signUp({
          email,
          password
        }),
        15000,
        "The account creation request timed out. Check your internet connection and try again."
      );
    }

    if (result.error) {
      throw result.error;
    }

    if (result.data?.session) {
      currentUser =
        result.data.user ||
        result.data.session.user;

      await enterApp();
    } else {
      msg.textContent =
        "Account created. Check your email if confirmation is enabled, then sign in.";
    }
  } catch (error) {
    console.error("Authentication error:", error);

    msg.textContent =
      error?.message ||
      "Authentication failed.";
  }
}

/* =========================================================
   ENTER APP
   ========================================================= */

async function enterApp() {
  try {
    /*
      Profile request gets its own timeout.
    */
    const profileResult =
      await withTimeout(
        supabase
          .from("profiles")
          .select(
            "id,username,display_name,avatar,created_at"
          )
          .eq("id", currentUser.id)
          .maybeSingle(),

        10000,

        "Supabase did not respond while loading your profile."
      );

    if (profileResult.error) {
      renderDbError(
        profileResult.error.message
      );
      return;
    }

    currentProfile =
      profileResult.data || null;

    if (!currentProfile) {
      renderProfile(true);
      return;
    }

    /*
      Loading other users also gets a timeout.
    */
    await withTimeout(
      loadPeople(),
      10000,
      "Supabase did not respond while loading Leo users."
    );

    renderHome();
    startPeopleRefresh();
  } catch (error) {
    console.error("Enter app error:", error);

    showStartupError(
      "Could not load Leo Chat",
      error?.message ||
        "Your account was found, but Leo Chat could not finish loading."
    );
  }
}

/* =========================================================
   LOAD PEOPLE
   ========================================================= */

async function loadPeople() {
  const result = await supabase
    .from("profiles")
    .select(
      "id,username,display_name,avatar,created_at"
    )
    .neq("id", currentUser.id)
    .order("created_at", {
      ascending: true
    });

  if (result.error) {
    throw result.error;
  }

  people = result.data || [];

  return people;
}

/* =========================================================
   DATABASE ERROR
   ========================================================= */

function renderDbError(message) {
  showStartupError(
    "Supabase connection problem",
    message
  );
}

/* =========================================================
   PROFILE
   ========================================================= */

function renderProfile(firstTime = false) {
  render(`
    <main class="screen">

      <section class="topbar">
        <h2>
          ${
            firstTime
              ? "Create Your Profile"
              : "Edit Profile"
          }
        </h2>
      </section>

      <section class="profile-form">

        <div
          class="avatar-big"
          id="avatarPreview"
        >
          🦁
        </div>

        <div class="avatar-row">
          ${
            ["🦁", "🐯", "🐺", "🦊", "🐼", "🐻"]
              .map(
                (x) => `
                  <button
                    type="button"
                    class="avatar-choice"
                    data-avatar="${x}"
                  >
                    ${x}
                  </button>
                `
              )
              .join("")
          }
        </div>

        <input
          id="displayName"
          placeholder="Display name"
          value="${escapeHtml(
            currentProfile?.display_name || ""
          )}"
        >

        <input
          id="username"
          placeholder="Username"
          autocapitalize="none"
          value="${escapeHtml(
            currentProfile?.username || ""
          )}"
        >

        <button
          class="gold"
          id="saveProfile"
        >
          Save Profile
        </button>

        ${
          !firstTime
            ? `
              <button
                class="outline"
                id="cancelProfile"
              >
                Cancel
              </button>
            `
            : ""
        }

        <p
          id="profileMsg"
          class="message"
        ></p>

      </section>
    </main>
  `);

  let chosenAvatar =
    currentProfile?.avatar || "🦁";

  document.getElementById(
    "avatarPreview"
  ).textContent = chosenAvatar;

  document
    .querySelectorAll(".avatar-choice")
    .forEach((button) => {
      button.onclick = () => {
        chosenAvatar =
          button.dataset.avatar;

        document.getElementById(
          "avatarPreview"
        ).textContent = chosenAvatar;
      };
    });

  document.getElementById(
    "saveProfile"
  ).onclick = async () => {
    const displayName =
      document
        .getElementById("displayName")
        .value.trim();

    const username =
      document
        .getElementById("username")
        .value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "");

    const msg =
      document.getElementById("profileMsg");

    if (!displayName || !username) {
      msg.textContent =
        "Enter a display name and username.";
      return;
    }

    const payload = {
      id: currentUser.id,
      display_name: displayName,
      username,
      avatar: chosenAvatar
    };

    msg.textContent =
      "Saving profile...";

    try {
      const result = currentProfile
        ? await withTimeout(
            supabase
              .from("profiles")
              .update(payload)
              .eq("id", currentUser.id)
              .select()
              .single(),

            10000,

            "Saving your profile timed out."
          )
        : await withTimeout(
            supabase
              .from("profiles")
              .insert(payload)
              .select()
              .single(),

            10000,

            "Creating your profile timed out."
          );

      if (result.error) {
        throw result.error;
      }

      currentProfile =
        result.data;

      await loadPeople();

      renderHome();
    } catch (error) {
      console.error(
        "Profile save error:",
        error
      );

      msg.textContent =
        error?.message ||
        "Could not save your profile.";
    }
  };

  const cancel =
    document.getElementById(
      "cancelProfile"
    );

  if (cancel) {
    cancel.onclick = renderHome;
  }
}

/* =========================================================
   HOME
   ========================================================= */

function renderHome() {
  render(`
    <main class="app-shell">

      <header class="app-header">

        <div>
          <h1>Leo Chat 🦁</h1>

          <p>
            ${escapeHtml(
              currentProfile?.display_name ||
                "Welcome"
            )}
          </p>
        </div>

        <div class="header-actions">

          <button
            class="icon-btn"
            id="refresh"
          >
            ↻
          </button>

          <button
            class="icon-btn"
            id="settings"
          >
            ⚙️
          </button>

        </div>

      </header>

      <section
        class="people-list"
        id="peopleList"
      >

        ${
          people.length
            ? people
                .map(personRow)
                .join("")
            : `
              <div class="empty">

                <div>🦁</div>

                <h3>
                  No other Leo users yet
                </h3>

                <p>
                  Create another Leo account
                  to start chatting.
                </p>

              </div>
            `
        }

      </section>

      <nav class="bottom-nav">

        <button class="active">
          💬
          <span>Chats</span>
        </button>

        <button
          onclick="renderPlaceholder('Moments','✨')"
        >
          ✨
          <span>Moments</span>
        </button>

        <button
          onclick="renderPlaceholder('Calls','📞')"
        >
          📞
          <span>Calls</span>
        </button>

        <button id="settings2">
          ⚙️
          <span>Settings</span>
        </button>

      </nav>

    </main>
  `);

  document.getElementById(
    "refresh"
  ).onclick = async () => {
    try {
      await loadPeople();
      renderHome();
    } catch (error) {
      alert(
        error?.message ||
          "Could not refresh users."
      );
    }
  };

  document.getElementById(
    "settings"
  ).onclick = renderSettings;

  document.getElementById(
    "settings2"
  ).onclick = renderSettings;

  document
    .querySelectorAll("[data-person]")
    .forEach((element) => {
      element.onclick = () =>
        openChat(
          element.dataset.person
        );
    });
}

/* =========================================================
   PERSON ROW
   ========================================================= */

function personRow(person) {
  return `
    <button
      class="person-row"
      data-person="${escapeHtml(person.id)}"
    >

      <div class="person-avatar">
        ${escapeHtml(
          person.avatar || "🦁"
        )}
      </div>

      <div class="person-info">

        <strong>
          ${escapeHtml(
            person.display_name
          )}
        </strong>

        <span>
          @${escapeHtml(
            person.username
          )}
        </span>

        <small>
          Leo user
        </small>

      </div>

      <span class="chevron">
        ›
      </span>

    </button>
  `;
}

/* =========================================================
   OPEN CHAT
   ========================================================= */

async function openChat(personId) {
  selectedPerson =
    people.find(
      (person) =>
        person.id === personId
    );

  if (!selectedPerson) {
    return;
  }

  messages = [];
  selectedMedia = null;

  renderChat();

  try {
    await loadMessages();
    renderChat();
    subscribeChat();
  } catch (error) {
    console.error(
      "Open chat error:",
      error
    );

    alert(
      error?.message ||
        "Could not load this conversation."
    );
  }
}

/* =========================================================
   LOAD MESSAGES
   ========================================================= */

async function loadMessages() {
  if (
    !currentUser ||
    !selectedPerson
  ) {
    return;
  }

  const result =
    await withTimeout(
      supabase
        .from("messages")
        .select(
          "id,sender_id,receiver_id,message,created_at"
        )
        .or(
          `and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedPerson.id}),and(sender_id.eq.${selectedPerson.id},receiver_id.eq.${currentUser.id})`
        )
        .order("created_at", {
          ascending: true
        }),

      10000,

      "Loading messages timed out."
    );

  if (result.error) {
    throw result.error;
  }

  messages =
    result.data || [];

  return messages;
}

/* =========================================================
   CHAT
   ========================================================= */

function renderChat() {
  if (!selectedPerson) {
    renderHome();
    return;
  }

  render(`
    <main class="app-shell chat-shell">

      <header class="chat-header">

        <button
          class="back"
          id="back"
        >
          ‹
        </button>

        <div class="person-avatar">
          ${escapeHtml(
            selectedPerson.avatar ||
              "🦁"
          )}
        </div>

        <div class="chat-title">

          <strong>
            ${escapeHtml(
              selectedPerson.display_name
            )}
          </strong>

          <span>
            @${escapeHtml(
              selectedPerson.username
            )}
          </span>

        </div>

        <button
          class="icon-btn"
          onclick="alert('Voice calling will be added to the calling module.')"
        >
          📞
        </button>

        <button
          class="icon-btn"
          onclick="alert('Video calling will be added to the calling module.')"
        >
          🎥
        </button>

      </header>

      <section
        class="chat-messages"
        id="chatMessages"
      >

        ${
          messages.length
            ? messages
                .map(messageBubble)
                .join("")
            : `
              <div class="empty-chat">
                <div>🦁</div>
                <p>
                  Start the conversation.
                </p>
              </div>
            `
        }

      </section>

      <div
        id="mediaPreview"
      ></div>

      <form
        class="composer"
        id="composer"
      >

        <button
          type="button"
          class="attach"
          id="attach"
        >
          📎
        </button>

        <input
          id="messageInput"
          placeholder="Message"
          autocomplete="off"
        >

        <button
          type="submit"
          class="send"
        >
          ➤
        </button>

      </form>

      <div
        class="attach-sheet hidden"
        id="attachSheet"
      >

        <button
          type="button"
          id="pickPhoto"
        >
          🖼️ Photos
        </button>

        <button
          type="button"
          id="pickVideo"
        >
          🎥 Video
        </button>

        <button
          type="button"
          id="sendLocation"
        >
          📍 Location
        </button>

        <button
          type="button"
          id="closeAttach"
        >
          Cancel
        </button>

      </div>

    </main>
  `);

  document.getElementById(
    "back"
  ).onclick = closeChat;

  document.getElementById(
    "composer"
  ).onsubmit = sendMessage;

  document.getElementById(
    "attach"
  ).onclick = () => {
    document
      .getElementById("attachSheet")
      .classList.remove("hidden");
  };

  document.getElementById(
    "closeAttach"
  ).onclick = () => {
    document
      .getElementById("attachSheet")
      .classList.add("hidden");
  };

  document.getElementById(
    "pickPhoto"
  ).onclick = () =>
    pickMedia("image/*");

  document.getElementById(
    "pickVideo"
  ).onclick = () =>
    pickMedia("video/*");

  document.getElementById(
    "sendLocation"
  ).onclick = sendLocation;

  scrollChat();
}

/* =========================================================
   MESSAGE BUBBLE
   ========================================================= */

function messageBubble(item) {
  const mine =
    item.sender_id ===
    currentUser.id;

  return `
    <div
      class="bubble ${
        mine ? "mine" : "theirs"
      }"
    >

      <div>
        ${escapeHtml(
          item.message
        )}
      </div>

      ${
        mine
          ? `<small>✓✓</small>`
          : ""
      }

    </div>
  `;
}

/* =========================================================
   SCROLL CHAT
   ========================================================= */

function scrollChat() {
  const element =
    document.getElementById(
      "chatMessages"
    );

  if (element) {
    element.scrollTop =
      element.scrollHeight;
  }
}

/* =========================================================
   CLOSE CHAT
   ========================================================= */

function closeChat() {
  unsubscribeChat();

  selectedPerson = null;
  messages = [];
  selectedMedia = null;

  renderHome();
}

/* =========================================================
   REALTIME CHAT
   ========================================================= */

function subscribeChat() {
  unsubscribeChat();

  if (
    !supabase ||
    !currentUser ||
    !selectedPerson
  ) {
    return;
  }

  const channelName =
    `leo-chat-${currentUser.id}-${selectedPerson.id}`;

  messageChannel =
    supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages"
        },
        async (payload) => {
          if (!selectedPerson) {
            return;
          }

          const message =
            payload.new || {};

          const belongsToChat =
            (
              message.sender_id ===
                currentUser.id &&
              message.receiver_id ===
                selectedPerson.id
            ) ||
            (
              message.sender_id ===
                selectedPerson.id &&
              message.receiver_id ===
                currentUser.id
            );

          if (!belongsToChat) {
            return;
          }

          try {
            await loadMessages();

            if (selectedPerson) {
              renderChat();
              subscribeChat();
            }
          } catch (error) {
            console.error(
              "Realtime message refresh error:",
              error
            );
          }
        }
      )
      .subscribe();
}

/* =========================================================
   UNSUBSCRIBE
   ========================================================= */

function unsubscribeChat() {
  if (
    messageChannel &&
    supabase
  ) {
    supabase.removeChannel(
      messageChannel
    );

    messageChannel = null;
  }
}

/* =========================================================
   SEND MESSAGE
   ========================================================= */

async function sendMessage(event) {
  event.preventDefault();

  const input =
    document.getElementById(
      "messageInput"
    );

  if (!input) {
    return;
  }

  const text =
    input.value.trim();

  if (
    !text &&
    !selectedMedia
  ) {
    return;
  }

  let outgoing = text;

  if (
    selectedMedia?.type ===
    "image"
  ) {
    outgoing = text
      ? `📷 Photo\n${text}`
      : "📷 Photo";
  }

  if (
    selectedMedia?.type ===
    "video"
  ) {
    outgoing = text
      ? `🎥 Video\n${text}`
      : "🎥 Video";
  }

  try {
    const result =
      await withTimeout(
        supabase
          .from("messages")
          .insert({
            sender_id:
              currentUser.id,

            receiver_id:
              selectedPerson.id,

            message:
              outgoing
          }),

        10000,

        "Sending the message timed out."
      );

    if (result.error) {
      throw result.error;
    }

    input.value = "";

    selectedMedia = null;

    const preview =
      document.getElementById(
        "mediaPreview"
      );

    if (preview) {
      preview.innerHTML = "";
    }

    await loadMessages();

    renderChat();
    subscribeChat();
  } catch (error) {
    console.error(
      "Send message error:",
      error
    );

    alert(
      error?.message ||
        "Could not send the message."
    );
  }
}

/* =========================================================
   PICK MEDIA
   ========================================================= */

function pickMedia(accept) {
  const sheet =
    document.getElementById(
      "attachSheet"
    );

  if (sheet) {
    sheet.classList.add(
      "hidden"
    );
  }

  const input =
    document.createElement(
      "input"
    );

  input.type = "file";
  input.accept = accept;
  input.multiple = false;

  input.onchange = () => {
    const file =
      input.files?.[0];

    if (!file) {
      return;
    }

    selectedMedia = {
      type: file.type.startsWith(
        "video/"
      )
        ? "video"
        : "image",

      file
    };

    const preview =
      document.getElementById(
        "mediaPreview"
      );

    if (!preview) {
      return;
    }

    preview.innerHTML = `
      <div class="media-preview">

        <span>
          ${
            selectedMedia.type ===
            "image"
              ? "🖼️ Photo selected"
              : "🎥 Video selected"
          }
        </span>

        <button
          type="button"
          id="removeMedia"
        >
          ×
        </button>

      </div>
    `;

    document.getElementById(
      "removeMedia"
    ).onclick = () => {
      selectedMedia = null;

      preview.innerHTML = "";
    };
  };

  input.click();
}

/* =========================================================
   SEND LOCATION
   ========================================================= */

async function sendLocation() {
  const sheet =
    document.getElementById(
      "attachSheet"
    );

  if (sheet) {
    sheet.classList.add(
      "hidden"
    );
  }

  try {
    const result =
      await withTimeout(
        supabase
          .from("messages")
          .insert({
            sender_id:
              currentUser.id,

            receiver_id:
              selectedPerson.id,

            message:
              "📍 Location"
          }),

        10000,

        "Sending the location message timed out."
      );

    if (result.error) {
      throw result.error;
    }

    await loadMessages();

    renderChat();
    subscribeChat();
  } catch (error) {
    console.error(
      "Location message error:",
      error
    );

    alert(
      error?.message ||
        "Could not send location."
    );
  }
}

/* =========================================================
   SETTINGS
   ========================================================= */

function renderSettings() {
  render(`
    <main class="app-shell">

      <header class="simple-header">
        <h1>
          Settings ⚙️
        </h1>
      </header>

      <section class="settings">

        <button
          class="setting-row"
          id="profileEdit"
        >
          👤

          <span>
            <b>Profile</b>

            <small>
              ${escapeHtml(
                currentProfile?.display_name ||
                  ""
              )}
            </small>
          </span>

          ›
        </button>

        <button
          class="setting-row"
          onclick="alert('Privacy controls will be added to the privacy module.')"
        >
          🔐

          <span>
            <b>
              Privacy & Security
            </b>

            <small>
              Control your privacy
            </small>
          </span>

          ›
        </button>

        <button
          class="setting-row"
          onclick="alert('Browser notifications require permission and will be connected in the notification module.')"
        >
          🔔

          <span>
            <b>
              Notifications
            </b>

            <small>
              Messages and alerts
            </small>
          </span>

          ›
        </button>

        <button
          class="setting-row logout"
          id="logout"
        >
          🚪

          <span>
            <b>
              Log Out
            </b>

            <small>
              Sign out of this Leo Chat account
            </small>
          </span>
        </button>

      </section>

      <nav class="bottom-nav">

        <button
          onclick="renderHome()"
        >
          💬
          <span>Chats</span>
        </button>

        <button
          onclick="renderPlaceholder('Moments','✨')"
        >
          ✨
          <span>Moments</span>
        </button>

        <button
          onclick="renderPlaceholder('Calls','📞')"
        >
          📞
          <span>Calls</span>
        </button>

        <button class="active">
          ⚙️
          <span>Settings</span>
        </button>

      </nav>

    </main>
  `);

  document.getElementById(
    "profileEdit"
  ).onclick = () =>
    renderProfile(false);

  document.getElementById(
    "logout"
  ).onclick = logout;
}

/* =========================================================
   LOGOUT
   ========================================================= */

async function logout() {
  try {
    await withTimeout(
      supabase.auth.signOut(),
      10000,
      "Logout request timed out."
    );
  } catch (error) {
    console.error(
      "Logout error:",
      error
    );
  }

  currentUser = null;
  currentProfile = null;
  people = [];
  selectedPerson = null;
  messages = [];
  selectedMedia = null;

  unsubscribeChat();

  if (peopleTimer) {
    clearInterval(
      peopleTimer
    );

    peopleTimer = null;
  }

  renderWelcome();
}

/* =========================================================
   PLACEHOLDER MODULES
   ========================================================= */

function renderPlaceholder(
  title,
  icon
) {
  render(`
    <main class="app-shell">

      <header class="simple-header">
        <h1>
          ${icon} ${escapeHtml(
            title
          )}
        </h1>
      </header>

      <section class="placeholder">

        <div>
          ${icon}
        </div>

        <h2>
          Leo ${escapeHtml(
            title
          )}
        </h2>

        <p>
          This module is ready
          for the next build stage.
        </p>

      </section>

      <nav class="bottom-nav">

        <button
          onclick="renderHome()"
        >
          💬
          <span>Chats</span>
        </button>

        <button
          onclick="renderPlaceholder('Moments','✨')"
        >
          ✨
          <span>Moments</span>
        </button>

        <button
          onclick="renderPlaceholder('Calls','📞')"
        >
          📞
          <span>Calls</span>
        </button>

        <button
          onclick="renderSettings()"
        >
          ⚙️
          <span>Settings</span>
        </button>

      </nav>

    </main>
  `);
}

/* =========================================================
   PEOPLE REFRESH
   ========================================================= */

function startPeopleRefresh() {
  if (peopleTimer) {
    clearInterval(
      peopleTimer
    );
  }

  peopleTimer =
    setInterval(
      async () => {
        if (
          !currentUser ||
          selectedPerson
        ) {
          return;
        }

        try {
          await loadPeople();
        } catch (error) {
          console.error(
            "People refresh error:",
            error
          );
        }
      },
      10000
    );
}

/* =========================================================
   GLOBAL ERROR HANDLERS
   ========================================================= */

window.addEventListener(
  "error",
  (event) => {
    console.error(
      "Global JavaScript error:",
      event.error || event.message
    );

    showStartupError(
      "Leo Chat could not start",
      event.message ||
        "A JavaScript error prevented Leo Chat from starting."
    );
  }
);

window.addEventListener(
  "unhandledrejection",
  (event) => {
    console.error(
      "Unhandled promise rejection:",
      event.reason
    );

    showStartupError(
      "Leo Chat could not start",
      event.reason?.message ||
        String(
          event.reason ||
            "An unexpected error occurred."
        )
    );
  }
);

/* =========================================================
   START
   ========================================================= */

boot();
