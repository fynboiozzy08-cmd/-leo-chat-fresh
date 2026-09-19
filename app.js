(() => {
  /* =========================================================
     LEO CHAT — WEB APP
     Stable version

     UPDATED AFTER NEW MOBILE CSS

     FIXES:
     - Startup alert removed
     - Profile username does not clear while typing
     - Search input does not clear while typing
     - Chat composer does not rebuild while typing
     - Realtime messages update messages only
     - Polling does not destroy active inputs
     - Attachments do not destroy typed messages
     - Failed sends restore typed message
     - Real Supabase attachments remain enabled
     - Presence remains enabled
     - Notifications remain enabled
     - Compatible with the new mobile styles.css
     ========================================================= */

  const cfg = window.LEO_CONFIG || {};
  const app = document.getElementById("app");

  /* =========================================================
     SUPABASE
     ========================================================= */

  if (
    !window.supabase ||
    typeof window.supabase.createClient !== "function"
  ) {
    app.innerHTML = `
      <div class="app">
        <div class="shell">
          <div class="screen center">
            <img class="logo" src="./logo.svg">
            <h2>Leo Chat</h2>
            <p class="muted">
              Supabase could not be loaded.
            </p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
    app.innerHTML = `
      <div class="app">
        <div class="shell">
          <div class="screen center">
            <img class="logo" src="./logo.svg">
            <h2>Leo Chat</h2>
            <p class="muted">
              Supabase configuration is missing.
            </p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const db = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_KEY
  );

  const MEDIA_BUCKET = "chat-media";

  /* =========================================================
     STATE
     ========================================================= */

  let state = {
    user: null,
    profile: null,
    screen: "home",
    chat: null,
    profiles: [],
    messages: [],
    attachments: {},
    attachmentUrls: {},
    presence: {},

    moments: JSON.parse(
      localStorage.getItem("leo_moments") || "[]"
    ),

    notifications: JSON.parse(
      localStorage.getItem("leo_notifications") || "[]"
    ),

    settings: JSON.parse(
      localStorage.getItem("leo_settings") ||
        '{"messages":true,"calls":true,"moments":true}'
    )
  };

  let messageDraft = "";
  let searchDraft = "";

  let chatRenderToken = 0;
  let sendingMessage = false;

  let poll = null;
  let presencePoll = null;
  let messageChannel = null;
  let presenceChannel = null;
  let authSubscription = null;

  let profileFormActive = false;
  let appInitialized = false;

  /* =========================================================
     HELPERS
     ========================================================= */

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;"
        }[c])
    );

  function icon(x) {
    return `<span>${x}</span>`;
  }

  function toast(message) {
    const shell = app.querySelector(".shell");

    if (!shell) {
      alert(message);
      return;
    }

    const d = document.createElement("div");

    d.className = "toast";
    d.textContent = message;

    shell.appendChild(d);

    setTimeout(() => {
      d.remove();
    }, 3000);
  }

  function formatTime(value) {
    if (!value) return "";

    try {
      return new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      });
    } catch {
      return "";
    }
  }

  function formatLastSeen(value) {
    if (!value) {
      return "Offline";
    }

    try {
      const date = new Date(value);
      const diff = Date.now() - date.getTime();

      if (diff < 60 * 1000) {
        return "last seen just now";
      }

      if (diff < 60 * 60 * 1000) {
        const mins = Math.floor(diff / 60000);
        return `last seen ${mins} min ago`;
      }

      return (
        "last seen " +
        date.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        })
      );
    } catch {
      return "Offline";
    }
  }

  function isOnline(userId) {
    return Boolean(
      state.presence[userId]?.is_online
    );
  }

  function randomId() {
    try {
      return crypto.randomUUID();
    } catch {
      return (
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2)
      );
    }
  }

  function cleanFileName(name) {
    return String(name || "leo-file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 150);
  }

  /* =========================================================
     DRAFT PROTECTION
     ========================================================= */

  window.updateMessageDraft = (value) => {
    messageDraft = String(value ?? "");
  };

  function captureMessageDraft() {
    const input = document.getElementById("msg");

    if (input) {
      messageDraft = input.value;
    }

    return messageDraft;
  }

  function restoreMessageDraft() {
    const input = document.getElementById("msg");

    if (!input) return;

    input.value = messageDraft;
  }

  window.updateSearchDraft = (value) => {
    searchDraft = String(value ?? "");
  };

  function captureSearchDraft() {
    const input = document.getElementById("q");

    if (input) {
      searchDraft = input.value;
    }

    return searchDraft;
  }

  function restoreSearchDraft() {
    const input = document.getElementById("q");

    if (!input) return;

    input.value = searchDraft;
  }

  /* =========================================================
     PRESENCE
     ========================================================= */

  async function ensurePresence() {
    if (!state.user) return;

    const now = new Date().toISOString();

    const { error } = await db
      .from("user_presence")
      .upsert(
        {
          user_id: state.user.id,
          is_online: true,
          last_seen_at: now,
          current_activity:
            state.screen === "chat"
              ? "chatting"
              : "online",
          updated_at: now
        },
        {
          onConflict: "user_id"
        }
      );

    if (error) {
      console.log(
        "Presence update:",
        error.message
      );
    }
  }

  async function updatePresenceActivity() {
    if (!state.user) return;

    const now = new Date().toISOString();

    const { error } = await db
      .from("user_presence")
      .upsert(
        {
          user_id: state.user.id,
          is_online: true,
          last_seen_at: now,
          current_activity:
            state.screen === "chat"
              ? "chatting"
              : "online",
          updated_at: now
        },
        {
          onConflict: "user_id"
        }
      );

    if (error) {
      console.log(
        "Presence activity:",
        error.message
      );
    }
  }

  async function markOffline() {
    if (!state.user) return;

    const now = new Date().toISOString();

    try {
      await db
        .from("user_presence")
        .update({
          is_online: false,
          current_activity: "offline",
          last_seen_at: now,
          updated_at: now
        })
        .eq(
          "user_id",
          state.user.id
        );
    } catch (error) {
      console.log(
        "Offline error:",
        error.message
      );
    }
  }

  async function loadPresence() {
    if (!state.user) return;

    const { data, error } = await db
      .from("user_presence")
      .select(
        "user_id,is_online,last_seen_at,current_activity,updated_at"
      );

    if (error) {
      console.log(
        "Presence loading:",
        error.message
      );
      return;
    }

    state.presence = {};

    (data || []).forEach((item) => {
      state.presence[item.user_id] = item;
    });
  }

  async function startPresence() {
    if (!state.user) return;

    await ensurePresence();
    await loadPresence();

    if (presenceChannel) {
      try {
        await db.removeChannel(
          presenceChannel
        );
      } catch {}
    }

    presenceChannel = db.channel(
      "leo-presence",
      {
        config: {
          presence: {
            key: state.user.id
          }
        }
      }
    );

    presenceChannel
      .on(
        "presence",
        { event: "sync" },
        () => {
          try {
            const presenceState =
              presenceChannel.presenceState();

            Object.keys(
              presenceState || {}
            ).forEach((key) => {
              const entries =
                presenceState[key] || [];

              const entry = entries[0];

              const userId =
                entry?.user_id || key;

              if (!userId) return;

              state.presence[userId] = {
                ...(state.presence[userId] || {}),
                user_id: userId,
                is_online: true,
                last_seen_at:
                  entry?.at ||
                  new Date().toISOString(),
                current_activity:
                  entry?.activity ||
                  "online"
              };
            });

            /*
              IMPORTANT:
              Never render setup/chat/search here.
              Background presence updates must not
              destroy active inputs.
            */

            if (
              state.screen === "home" ||
              state.screen === "search"
            ) {
              render();
            }

            if (
              state.screen === "chat"
            ) {
              updateChatHeaderStatus();
            }

          } catch (error) {
            console.log(
              "Presence sync:",
              error.message
            );
          }
        }
      )
      .on(
        "presence",
        { event: "join" },
        ({ key, newPresences }) => {
          const entry =
            newPresences?.[0];

          const userId =
            entry?.user_id || key;

          if (userId) {
            state.presence[userId] = {
              ...(state.presence[userId] || {}),
              user_id: userId,
              is_online: true,
              last_seen_at:
                entry?.at ||
                new Date().toISOString(),
              current_activity:
                entry?.activity ||
                "online"
            };
          }

          if (
            state.screen === "home" ||
            state.screen === "search"
          ) {
            render();
          }

          if (
            state.screen === "chat"
          ) {
            updateChatHeaderStatus();
          }
        }
      )
      .on(
        "presence",
        { event: "leave" },
        ({ key }) => {
          if (key) {
            state.presence[key] = {
              ...(state.presence[key] || {}),
              user_id: key,
              is_online: false,
              last_seen_at:
                new Date().toISOString(),
              current_activity: "offline"
            };
          }

          if (
            state.screen === "home" ||
            state.screen === "search"
          ) {
            render();
          }

          if (
            state.screen === "chat"
          ) {
            updateChatHeaderStatus();
          }
        }
      )
      .subscribe(async (status) => {
        if (
          status === "SUBSCRIBED"
        ) {
          try {
            await presenceChannel.track({
              user_id: state.user.id,
              online: true,
              activity:
                state.screen === "chat"
                  ? "chatting"
                  : "online",
              at: new Date().toISOString()
            });
          } catch {}
        }
      });

    clearInterval(presencePoll);

    presencePoll = setInterval(
      async () => {
        if (!state.user) return;

        await ensurePresence();
        await loadPresence();

        /*
          NEVER rebuild active input screens.
        */

        if (
          state.screen === "home"
        ) {
          render();
        }

        if (
          state.screen === "search"
        ) {
          render();
        }

        if (
          state.screen === "chat"
        ) {
          updateChatHeaderStatus();
        }
      },
      10000
    );
  }

  async function stopPresence() {
    clearInterval(presencePoll);
    presencePoll = null;

    if (presenceChannel) {
      try {
        await presenceChannel.untrack();
      } catch {}

      try {
        await db.removeChannel(
          presenceChannel
        );
      } catch {}

      presenceChannel = null;
    }
  }

  /* =========================================================
     PROFILE
     ========================================================= */

  async function loadProfile() {
    if (!state.user) return;

    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", state.user.id)
      .maybeSingle();

    if (error) {
      console.log(
        "Profile:",
        error.message
      );
    }

    state.profile = data || null;
  }

  async function getProfiles() {
    if (!state.user) return;

    const { data, error } = await db
      .from("profiles")
      .select("*")
      .order("display_name");

    if (error) {
      console.log(
        "Profiles:",
        error.message
      );
      return;
    }

    state.profiles = data || [];
  }

  /* =========================================================
     MESSAGES
     ========================================================= */

  async function getMessages() {
    if (!state.chat || !state.user) {
      return;
    }

    const a = state.user.id;
    const b = state.chat.id;

    const { data, error } = await db
      .from("messages")
      .select("*")
      .or(
        `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`
      )
      .order("created_at", {
        ascending: true
      });

    if (error) {
      console.log(
        "Messages:",
        error.message
      );
      return;
    }

    state.messages = data || [];

    await loadAttachments();
  }

  async function loadAttachments() {
    if (!state.messages.length) {
      state.attachments = {};
      return;
    }

    const ids = state.messages.map(
      (m) => m.id
    );

    const { data, error } = await db
      .from("message_attachments")
      .select("*")
      .in("message_id", ids)
      .order("created_at", {
        ascending: true
      });

    if (error) {
      console.log(
        "Attachments:",
        error.message
      );
      return;
    }

    state.attachments = {};

    (data || []).forEach((item) => {
      if (
        !state.attachments[
          item.message_id
        ]
      ) {
        state.attachments[
          item.message_id
        ] = [];
      }

      state.attachments[
        item.message_id
      ].push(item);
    });
  }

  /* =========================================================
     ATTACHMENTS
     ========================================================= */

  function getAttachmentType(file) {
    const type = file?.type || "";

    if (
      type.startsWith("image/")
    ) {
      return "image";
    }

    if (
      type.startsWith("video/")
    ) {
      return "video";
    }

    if (
      type.startsWith("audio/")
    ) {
      return "audio";
    }

    if (
      type.includes("pdf") ||
      type.includes("document") ||
      type.includes("word") ||
      type.includes("text") ||
      type.includes("spreadsheet") ||
      type.includes("excel")
    ) {
      return "document";
    }

    return "file";
  }

  async function uploadAttachment(file) {
    if (!file) return;

    if (!state.user) {
      toast("You are not logged in.");
      return;
    }

    if (!state.chat) {
      toast("Open a chat first.");
      return;
    }

    captureMessageDraft();

    const {
      data: sessionData,
      error: sessionError
    } = await db.auth.getSession();

    if (sessionError) {
      alert(
        "Leo Chat session error:\n\n" +
          sessionError.message
      );
      return;
    }

    if (
      !sessionData?.session?.access_token
    ) {
      alert(
        "Your Leo Chat session has expired. Please log in again."
      );
      return;
    }

    const MAX_FILE_SIZE =
      50 * 1024 * 1024;

    if (file.size > MAX_FILE_SIZE) {
      alert(
        "This file is larger than the 50 MB limit."
      );
      return;
    }

    const attachmentType =
      getAttachmentType(file);

    const safeName =
      cleanFileName(file.name);

    const uniqueId = randomId();

    const storagePath =
      `${state.user.id}/${uniqueId}/${safeName}`;

    toast(
      "Uploading " +
        file.name +
        "..."
    );

    try {
      const {
        data: uploadData,
        error: uploadError
      } = await db.storage
        .from(MEDIA_BUCKET)
        .upload(
          storagePath,
          file,
          {
            cacheControl: "3600",
            upsert: false,
            contentType:
              file.type ||
              "application/octet-stream"
          }
        );

      if (uploadError) {
        throw new Error(
          "Storage upload failed: " +
            uploadError.message
        );
      }

      let messageLabel = "📎 File";

      if (
        attachmentType === "image"
      ) {
        messageLabel = "📷 Photo";
      }

      if (
        attachmentType === "video"
      ) {
        messageLabel = "🎥 Video";
      }

      if (
        attachmentType === "audio"
      ) {
        messageLabel = "🎵 Audio";
      }

      const {
        data: message,
        error: messageError
      } = await db
        .from("messages")
        .insert({
          sender_id:
            state.user.id,
          receiver_id:
            state.chat.id,
          message: messageLabel
        })
        .select()
        .single();

      if (messageError) {
        await db.storage
          .from(MEDIA_BUCKET)
          .remove([storagePath]);

        throw new Error(
          "Message creation failed: " +
            messageError.message
        );
      }

      const {
        data: attachment,
        error: attachmentError
      } = await db
        .from("message_attachments")
        .insert({
          message_id:
            message.id,
          sender_id:
            state.user.id,
          file_name:
            file.name,
          file_path:
            storagePath,
          mime_type:
            file.type ||
            "application/octet-stream",
          file_size:
            file.size,
          attachment_type:
            attachmentType
        })
        .select()
        .single();

      if (attachmentError) {
        await db.storage
          .from(MEDIA_BUCKET)
          .remove([storagePath]);

        throw new Error(
          "Attachment record failed: " +
            attachmentError.message
        );
      }

      delete state.attachmentUrls[
        storagePath
      ];

      toast(
        "Attachment sent successfully."
      );

      await getMessages();
      await updateChatMessages();
      await updatePresenceActivity();

    } catch (error) {
      console.error(
        "LEO ATTACHMENT ERROR:",
        error
      );

      toast(
        error?.message ||
          "Attachment could not be sent."
      );

      restoreMessageDraft();
    }
  }

  async function getAttachmentUrl(path) {
    if (!path) return null;

    const cached =
      state.attachmentUrls[path];

    if (
      cached &&
      cached.expiresAt > Date.now()
    ) {
      return cached.url;
    }

    const {
      data: sessionData,
      error: sessionError
    } = await db.auth.getSession();

    if (
      sessionError ||
      !sessionData?.session?.access_token
    ) {
      return null;
    }

    const {
      data,
      error
    } = await db.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(
        path,
        3600
      );

    if (error) {
      console.error(
        "SIGNED URL ERROR:",
        error
      );
      return null;
    }

    const url =
      data?.signedUrl || null;

    if (url) {
      state.attachmentUrls[path] = {
        url,
        expiresAt:
          Date.now() +
          50 * 60 * 1000
      };
    }

    return url;
  }

  window.openAttachment =
    async (
      path
    ) => {
      if (!path) return;

      const url =
        await getAttachmentUrl(
          path
        );

      if (!url) {
        toast(
          "Could not open attachment."
        );
        return;
      }

      window.open(
        url,
        "_blank",
        "noopener,noreferrer"
      );
    };

  function renderAttachment(
    attachment
  ) {
    const safePath =
      encodeURIComponent(
        attachment.file_path
      );

    if (
      attachment.attachment_type ===
      "image"
    ) {
      if (attachment.signedUrl) {
        return `
          <button
            class="attachment-image"
            onclick="
              openAttachment(
                decodeURIComponent('${safePath}')
              )
            "
          >
            <img
              src="${esc(
                attachment.signedUrl
              )}"
              alt="Leo Chat photo"
              style="
                width:100%;
                max-width:280px;
                max-height:360px;
                object-fit:cover;
                display:block;
                border-radius:12px;
              "
            >
          </button>
        `;
      }

      return `
        <button
          class="attachment-image"
          onclick="
            openAttachment(
              decodeURIComponent('${safePath}')
            )
          "
        >
          <div class="attachment-loading">
            📷 Loading photo...
          </div>
        </button>
      `;
    }

    const attachmentIcon =
      attachment.attachment_type ===
      "video"
        ? "🎥"
        : attachment.attachment_type ===
          "audio"
        ? "🎵"
        : "📎";

    return `
      <button
        class="attachment-file"
        onclick="
          openAttachment(
            decodeURIComponent('${safePath}')
          )
        "
      >
        ${attachmentIcon}

        <span>
          ${esc(
            attachment.file_name
          )}
        </span>
      </button>
    `;
  }

  async function prepareAttachmentUrls() {
    const all = [];

    Object.keys(
      state.attachments
    ).forEach((messageId) => {
      const list =
        state.attachments[
          messageId
        ] || [];

      list.forEach((attachment) => {
        if (
          attachment.attachment_type ===
          "image"
        ) {
          all.push(attachment);
        }
      });
    });

    await Promise.all(
      all.map(async (attachment) => {
        attachment.signedUrl =
          await getAttachmentUrl(
            attachment.file_path
          );
      })
    );
  }

  /* =========================================================
     CHAT DOM UPDATE ONLY
     ========================================================= */

  async function updateChatMessages() {
    if (
      state.screen !== "chat" ||
      !state.chat
    ) {
      return;
    }

    const messagesElement =
      document.getElementById(
        "messages"
      );

    if (!messagesElement) {
      return;
    }

    const savedDraft =
      captureMessageDraft();

    await prepareAttachmentUrls();

    if (
      state.screen !== "chat" ||
      !state.chat ||
      !messagesElement.isConnected
    ) {
      return;
    }

    messagesElement.innerHTML =
      state.messages.length
        ? state.messages
            .map(
              (m) =>
                renderMessage(m)
            )
            .join("")
        : `
            <div class="empty">
              Start the conversation 🦁
            </div>
          `;

    messageDraft = savedDraft;

    restoreMessageDraft();

    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const messagesElement =
      document.getElementById(
        "messages"
      );

    if (!messagesElement) return;

    setTimeout(() => {
      messagesElement.scrollTop =
        messagesElement.scrollHeight;
    }, 20);
  }

  function updateChatHeaderStatus() {
    if (
      state.screen !== "chat" ||
      !state.chat
    ) {
      return;
    }

    const header =
      document.querySelector(
        ".chathead .sub"
      );

    if (!header) return;

    const online =
      isOnline(
        state.chat.id
      );

    header.innerHTML = `
      <span
        class="status-dot ${
          online
            ? "online"
            : "offline"
        }"
      ></span>

      ${
        online
          ? "Online"
          : formatLastSeen(
              state.presence[
                state.chat.id
              ]?.last_seen_at
            )
      }
    `;
  }

  /* =========================================================
     POLLING
     ========================================================= */

  function startPolling() {
    clearInterval(poll);

    poll = setInterval(
      async () => {

        if (
          state.screen === "chat"
        ) {
          const oldMessages =
            state.messages || [];

          const oldCount =
            oldMessages.length;

          const oldLast =
            oldCount
              ? oldMessages[
                  oldCount - 1
                ]
              : null;

          const oldId =
            oldLast?.id || null;

          const oldTime =
            oldLast?.created_at ||
            null;

          await getMessages();

          const newMessages =
            state.messages || [];

          const newCount =
            newMessages.length;

          const newLast =
            newCount
              ? newMessages[
                  newCount - 1
                ]
              : null;

          const newId =
            newLast?.id || null;

          const newTime =
            newLast?.created_at ||
            null;

          const changed =
            oldCount !== newCount ||
            oldId !== newId ||
            oldTime !== newTime;

          if (changed) {
            await updateChatMessages();
          }

          await loadPresence();

          updateChatHeaderStatus();

          return;
        }

        /*
          Never render setup here.
          Never render chat here.
        */

        if (
          state.screen === "home"
        ) {
          await loadPresence();
          await renderHome();
        }

        if (
          state.screen === "search"
        ) {
          await loadPresence();
          filterPeople();
        }

      },
      5000
    );
  }

  /* =========================================================
     REALTIME
     ========================================================= */

  async function startMessageRealtime() {
    if (!state.user) return;

    if (messageChannel) {
      try {
        await db.removeChannel(
          messageChannel
        );
      } catch {}
    }

    messageChannel =
      db
        .channel(
          "leo-messages-" +
            state.user.id
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter:
              `receiver_id=eq.${state.user.id}`
          },
          async () => {

            if (
              state.screen === "chat"
            ) {
              await getMessages();
              await updateChatMessages();
            } else {
              addNotification(
                "New message",
                "You have a new Leo Chat message."
              );
            }
          }
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table:
              "message_attachments"
          },
          async () => {

            if (
              state.screen === "chat"
            ) {
              await getMessages();
              await updateChatMessages();
            }
          }
        )
        .subscribe();
  }

  /* =========================================================
     LAYOUT
     ========================================================= */

  function layout(
    inner,
    nav = true
  ) {
    return `
      <div class="app">
        <div class="shell">
          ${inner}
          ${
            nav
              ? navBar()
              : ""
          }
        </div>
      </div>
    `;
  }

  function navBar() {
    const n = [
      ["home", "💬", "Chats"],
      ["search", "⌕", "Search"],
      ["moments", "✦", "Moments"],
      ["calls", "☎", "Calls"],
      ["settings", "⚙", "Settings"]
    ];

    return `
      <div class="nav">
        ${n
          .map(
            (x) =>
              `
                <button
                  class="${
                    state.screen ===
                    x[0]
                      ? "active"
                      : ""
                  }"
                  onclick="
                    go('${x[0]}')
                  "
                >
                  ${icon(x[1])}
                  <b>${x[2]}</b>
                </button>
              `
          )
          .join("")}
      </div>
    `;
  }

  /* =========================================================
     NAVIGATION
     ========================================================= */

  window.go = async (
    screen
  ) => {
    /*
      Do not navigate away from profile setup
      while the user is typing.
    */

    if (
      profileFormActive &&
      state.screen === "setup" &&
      screen !== "setup"
    ) {
      return;
    }

    if (
      state.screen === "search"
    ) {
      captureSearchDraft();
    }

    state.screen = screen;

    if (
      screen !== "chat"
    ) {
      messageDraft = "";
      chatRenderToken++;
    }

    if (
      screen !== "search"
    ) {
      searchDraft = "";
    }

    await updatePresenceActivity();

    render();
  };

  window.openChatById =
    async (
      id
    ) => {
      const person =
        state.profiles.find(
          (p) => p.id === id
        );

      if (person) {
        await window.openChat(
          person
        );
        return;
      }

      await getProfiles();

      const found =
        state.profiles.find(
          (p) => p.id === id
        );

      if (!found) {
        toast(
          "User could not be found."
        );
        return;
      }

      await window.openChat(
        found
      );
    };

  window.openChat =
    async (
      person
    ) => {
      messageDraft = "";
      searchDraft = "";

      chatRenderToken++;

      state.chat = person;
      state.screen = "chat";
      state.messages = [];
      state.attachments = {};
      state.attachmentUrls = {};

      await updatePresenceActivity();
      await getMessages();
      await renderChat();
    };

  window.logout =
    async () => {
      profileFormActive = false;

      messageDraft = "";
      searchDraft = "";

      chatRenderToken++;

      try {
        await markOffline();
      } catch {}

      await stopPresence();

      if (messageChannel) {
        try {
          await db.removeChannel(
            messageChannel
          );
        } catch {}

        messageChannel = null;
      }

      clearInterval(poll);
      clearInterval(presencePoll);

      try {
        await db.auth.signOut();
      } catch {}

      state.user = null;
      state.profile = null;
      state.chat = null;
      state.messages = [];
      state.attachments = {};
      state.attachmentUrls = {};
      state.presence = {};
      state.screen = "home";

      appInitialized = false;

      render();
    };

  /* =========================================================
     AUTH
     ========================================================= */

  function renderAuth() {
    profileFormActive = false;

    app.innerHTML =
      layout(
        `
          <div
            class="screen center"
            style="
              justify-content:center;
              padding:28px
            "
          >

            <img
              class="logo"
              src="./logo.svg"
            >

            <h1>
              Leo Chat
            </h1>

            <p class="muted">
              Chat. Connect. Roar.
            </p>

            <input
              id="email"
              class="input"
              placeholder="Email"
              type="email"
              autocomplete="email"
            >

            <input
              id="pass"
              class="input"
              placeholder="Password"
              type="password"
              autocomplete="current-password"
            >

            <button
              class="btn"
              onclick="
                auth('signin')
              "
            >
              Sign in
            </button>

            <button
              class="btn secondary"
              onclick="
                auth('signup')
              "
            >
              Create account
            </button>

          </div>
        `,
        false
      );
  }

  window.auth =
    async (
      mode
    ) => {
      const email =
        document
          .getElementById("email")
          ?.value
          .trim();

      const password =
        document
          .getElementById("pass")
          ?.value;

      if (!email || !password) {
        return toast(
          "Enter email and password."
        );
      }

      toast(
        mode === "signup"
          ? "Creating account..."
          : "Signing in..."
      );

      try {
        const result =
          mode === "signup"
            ? await db.auth.signUp({
                email,
                password
              })
            : await db.auth.signInWithPassword({
                email,
                password
              });

        if (result.error) {
          return toast(
            result.error.message
          );
        }

        state.user =
          result.data.user;

        if (!state.user) {
          return toast(
            "Account created. Check your email if confirmation is required."
          );
        }

        profileFormActive = false;

        await loadProfile();

        if (state.profile) {
          await startPresence();
          await startMessageRealtime();
          startPolling();

          state.screen = "home";
        } else {
          state.screen = "setup";
          profileFormActive = true;
        }

        appInitialized = true;

        render();

      } catch (error) {
        toast(
          error.message ||
            "Authentication failed."
        );
      }
    };

  /* =========================================================
     PROFILE SETUP
     ========================================================= */

  function renderSetup() {
    state.screen = "setup";

    /*
      CRITICAL:
      If the profile inputs already exist,
      NEVER rebuild the screen.
    */

    const usernameInput =
      document.getElementById(
        "uname"
      );

    const displayInput =
      document.getElementById(
        "dname"
      );

    if (
      usernameInput &&
      displayInput
    ) {
      profileFormActive = true;
      return;
    }

    profileFormActive = true;

    app.innerHTML =
      layout(
        `
          <div
            class="screen center"
            style="
              justify-content:center;
              padding:25px
            "
          >

            <img
              class="logo"
              src="./logo.svg"
            >

            <h2>
              Set up your Leo profile
            </h2>

            <p class="muted">
              Enter Leo Chat
            </p>

            <input
              id="uname"
              class="input"
              placeholder="Username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
            >

            <input
              id="dname"
              class="input"
              placeholder="Display name"
              autocomplete="name"
            >

            <button
              class="btn"
              id="profileSaveButton"
              onclick="
                saveProfile()
              "
            >
              Enter Leo Chat
            </button>

          </div>
        `,
        false
      );
  }

  window.saveProfile =
    async () => {
      if (!state.user) {
        return toast(
          "Please log in again."
        );
      }

      const username =
        document
          .getElementById(
            "uname"
          )
          ?.value
          .trim()
          .toLowerCase();

      const display_name =
        document
          .getElementById(
            "dname"
          )
          ?.value
          .trim();

      if (
        !username ||
        !display_name
      ) {
        return toast(
          "Complete your profile."
        );
      }

      const cleanUsername =
        username.replace(
          /[^a-z0-9_]/g,
          ""
        );

      if (!cleanUsername) {
        return toast(
          "Username must contain letters, numbers or underscores."
        );
      }

      const button =
        document.getElementById(
          "profileSaveButton"
        );

      if (button) {
        button.disabled = true;
        button.textContent =
          "Saving...";
      }

      try {
        const {
          data,
          error
        } = await db
          .from("profiles")
          .insert({
            id: state.user.id,
            username:
              cleanUsername,
            display_name,
            avatar: "🦁"
          })
          .select()
          .single();

        if (error) {
          if (button) {
            button.disabled = false;
            button.textContent =
              "Enter Leo Chat";
          }

          return toast(
            error.message
          );
        }

        state.profile = data;

        profileFormActive =
          false;

        await ensurePresence();
        await getProfiles();

        state.screen = "home";

        render();

      } catch (error) {
        if (button) {
          button.disabled = false;
          button.textContent =
            "Enter Leo Chat";
        }

        toast(
          error.message ||
            "Could not save your profile."
        );
      }
    };

  /* =========================================================
     HOME
     ========================================================= */

  async function renderHome() {
    await Promise.all([
      getProfiles(),
      loadPresence()
    ]);

    if (
      state.screen !== "home"
    ) {
      return;
    }

    const people =
      state.profiles.filter(
        (p) =>
          p.id !== state.user.id
      );

    app.innerHTML =
      layout(
        `
          <div class="screen">

            <div class="top">

              <div class="brand">

                <img
                  src="./logo.svg"
                >

                Leo Chat

              </div>

              <button
                class="iconbtn"
                onclick="
                  openNotifications()
                "
              >
                🔔
              </button>

            </div>

            <div class="content">

              <div class="card">

                <div class="row">

                  <div class="avatar">
                    ${esc(
                      state.profile
                        ?.avatar ||
                        "🦁"
                    )}
                  </div>

                  <div class="grow">

                    <div class="name">
                      ${esc(
                        state.profile
                          ?.display_name ||
                          "Leo User"
                      )}
                    </div>

                    <div class="sub">
                      @${esc(
                        state.profile
                          ?.username ||
                          ""
                      )}
                    </div>

                    <div class="online-status">

                      <span
                        class="status-dot online"
                      ></span>

                      Online

                    </div>

                  </div>

                </div>

              </div>

              <h3>
                People
              </h3>

              ${
                people.length
                  ? people
                      .map(
                        (p) => {
                          const online =
                            isOnline(
                              p.id
                            );

                          return `
                            <div
                              class="listitem"
                              onclick="
                                openChatById('${esc(
                                  p.id
                                )}')
                              "
                            >

                              <div class="avatar">
                                ${esc(
                                  p.avatar ||
                                    "🦁"
                                )}
                              </div>

                              <div class="grow">

                                <div class="name">
                                  ${esc(
                                    p.display_name
                                  )}
                                </div>

                                <div class="sub">
                                  @${esc(
                                    p.username
                                  )}
                                </div>

                                <div class="online-status">

                                  <span
                                    class="status-dot ${
                                      online
                                        ? "online"
                                        : "offline"
                                    }"
                                  ></span>

                                  ${
                                    online
                                      ? "Online"
                                      : formatLastSeen(
                                          state
                                            .presence[
                                            p.id
                                          ]
                                            ?.last_seen_at
                                        )
                                  }

                                </div>

                              </div>

                              <div class="gold">
                                ›
                              </div>

                            </div>
                          `;
                        }
                      )
                      .join("")
                  : `
                      <div class="empty">
                        No other Leo users yet.
                      </div>
                    `
              }

            </div>

          </div>
        `
      );
  }

  /* =========================================================
     SEARCH
     ========================================================= */

  function renderSearch() {
    const existingInput =
      document.getElementById(
        "q"
      );

    const existingResults =
      document.getElementById(
        "results"
      );

    /*
      CRITICAL:
      Never rebuild the search screen
      while the user is typing.
    */

    if (
      existingInput &&
      existingResults
    ) {
      filterPeople();
      return;
    }

    app.innerHTML =
      layout(
        `
          <div
            class="screen search-screen"
          >

            <div class="top">

              <div class="brand">
                ${icon("⌕")}
                Search
              </div>

            </div>

            <div class="content">

              <input
                id="q"
                class="input search"
                placeholder="Search people..."
                autocomplete="off"
                value="${esc(
                  searchDraft
                )}"
                oninput="
                  updateSearchDraft(
                    this.value
                  );
                  filterPeople()
                "
              >

              <div
                id="results"
              ></div>

            </div>

          </div>
        `
      );

    restoreSearchDraft();

    filterPeople();
  }

  let searchTimer = null;

  async function filterPeople() {
    captureSearchDraft();

    clearTimeout(
      searchTimer
    );

    searchTimer = setTimeout(
      async () => {

        await Promise.all([
          getProfiles(),
          loadPresence()
        ]);

        if (
          state.screen !==
          "search"
        ) {
          return;
        }

        const q =
          searchDraft
            .toLowerCase()
            .trim();

        const arr =
          state.profiles.filter(
            (p) =>
              p.id !==
                state.user.id &&
              `${p.display_name} ${p.username}`
                .toLowerCase()
                .includes(q)
          );

        const results =
          document.getElementById(
            "results"
          );

        const input =
          document.getElementById(
            "q"
          );

        if (!results) {
          return;
        }

        results.innerHTML =
          arr
            .map(
              (p) => {
                const online =
                  isOnline(
                    p.id
                  );

                return `
                  <div
                    class="listitem"
                    onclick="
                      openChatById('${esc(
                        p.id
                      )}')
                    "
                  >

                    <div class="avatar">
                      ${esc(
                        p.avatar ||
                          "🦁"
                      )}
                    </div>

                    <div class="grow">

                      <div class="name">
                        ${esc(
                          p.display_name
                        )}
                      </div>

                      <div class="sub">
                        @${esc(
                          p.username
                        )}
                      </div>

                      <div class="online-status">

                        <span
                          class="status-dot ${
                            online
                              ? "online"
                              : "offline"
                          }"
                        ></span>

                        ${
                          online
                            ? "Online"
                            : formatLastSeen(
                                state
                                  .presence[
                                  p.id
                                ]
                                  ?.last_seen_at
                              )
                        }

                      </div>

                    </div>

                  </div>
                `;
              }
            )
            .join("") ||
          `
            <div class="empty">
              No matches.
            </div>
          `;

        /*
          Restore the exact search text
          after results update.
        */

        if (
          input &&
          input.isConnected
        ) {
          input.value =
            searchDraft;
        }

      },
      150
    );
  }

  /* =========================================================
     CHAT
     ========================================================= */

  async function renderChat() {
    const person =
      state.chat;

    if (!person) {
      state.screen =
        "home";

      return renderHome();
    }

    const existingChat =
      document.querySelector(
        ".chat"
      );

    const existingChatId =
      existingChat?.dataset
        ?.chatId;

    /*
      CRITICAL:
      If chat already exists, only
      update messages. Do NOT rebuild
      the composer.
    */

    if (
      existingChat &&
      existingChatId ===
        person.id
    ) {
      await updateChatMessages();
      updateChatHeaderStatus();
      return;
    }

    const renderToken =
      ++chatRenderToken;

    await prepareAttachmentUrls();

    if (
      renderToken !==
        chatRenderToken ||
      state.screen !== "chat" ||
      !state.chat ||
      state.chat.id !==
        person.id
    ) {
      return;
    }

    const messages =
      state.messages || [];

    const online =
      isOnline(
        person.id
      );

    app.innerHTML =
      layout(
        `
          <div
            class="chat"
            data-chat-id="${esc(
              person.id
            )}"
          >

            <div class="chathead">

              <button
                class="back"
                onclick="
                  leaveChat()
                "
              >
                ‹
              </button>

              <div class="avatar">
                ${esc(
                  person.avatar ||
                    "🦁"
                )}
              </div>

              <div class="grow">

                <div class="name">
                  ${esc(
                    person.display_name
                  )}
                </div>

                <div class="sub">

                  <span
                    class="status-dot ${
                      online
                        ? "online"
                        : "offline"
                    }"
                  ></span>

                  ${
                    online
                      ? "Online"
                      : formatLastSeen(
                          state
                            .presence[
                            person.id
                          ]
                            ?.last_seen_at
                        )
                  }

                </div>

              </div>

              <button
                class="iconbtn"
                onclick="
                  callUser('voice')
                "
                title="Voice call"
              >
                ☎
              </button>

              <button
                class="iconbtn"
                onclick="
                  callUser('video')
                "
                title="Video call"
              >
                ▣
              </button>

            </div>

            <div
              class="messages"
              id="messages"
            >

              ${
                messages.length
                  ? messages
                      .map(
                        (m) =>
                          renderMessage(
                            m
                          )
                      )
                      .join("")
                  : `
                      <div class="empty">
                        Start the conversation 🦁
                      </div>
                    `
              }

            </div>

            <div class="composer">

              <button
                class="iconbtn"
                onclick="
                  document
                    .getElementById(
                      'attachmentInput'
                    )
                    .click()
                "
                title="Attach"
              >
                ＋
              </button>

              <input
                id="attachmentInput"
                class="photo-btn"
                type="file"
                accept="
                  image/*,
                  video/*,
                  audio/*,
                  .pdf,
                  .doc,
                  .docx,
                  .xls,
                  .xlsx,
                  .txt,
                  .zip
                "
                multiple
                onchange="
                  handleAttachments(event)
                "
              >

              <input
                id="msg"
                class="input"
                placeholder="Message..."
                autocomplete="off"
                value="${esc(
                  messageDraft
                )}"
                oninput="
                  updateMessageDraft(
                    this.value
                  )
                "
                onkeydown="
                  if(
                    event.key === 'Enter' &&
                    !event.shiftKey
                  ){
                    event.preventDefault();
                    sendMsg();
                  }
                "
              >

              <button
                class="send"
                onclick="
                  sendMsg()
                "
              >
                ➤
              </button>

            </div>

          </div>
        `,
        false
      );

    restoreMessageDraft();

    scrollChatToBottom();
  }

  function renderMessage(
    message
  ) {
    const mine =
      message.sender_id ===
      state.user.id;

    const attachments =
      state.attachments[
        message.id
      ] || [];

    return `
      <div
        class="bubble ${
          mine
            ? "mine"
            : "theirs"
        }"
      >

        ${
          message.message
            ? `
                <div>
                  ${esc(
                    message.message
                  )}
                </div>
              `
            : ""
        }

        ${
          attachments.length
            ? `
                <div class="attachment-list">

                  ${attachments
                    .map(
                      (attachment) =>
                        renderAttachment(
                          attachment
                        )
                    )
                    .join("")}

                </div>
              `
            : ""
        }

        <div class="message-meta">

          ${formatTime(
            message.created_at
          )}

          ${
            mine
              ? " ✓✓"
              : ""
          }

        </div>

      </div>
    `;
  }

  /* =========================================================
     SEND MESSAGE
     ========================================================= */

  window.sendMsg =
    async () => {
      if (
        sendingMessage
      ) {
        return;
      }

      const input =
        document.getElementById(
          "msg"
        );

      const text =
        (
          input?.value ??
          messageDraft
        ).trim();

      if (!text) {
        return;
      }

      if (
        !state.user ||
        !state.chat
      ) {
        return;
      }

      messageDraft = text;

      sendingMessage = true;

      const button =
        document.querySelector(
          ".send"
        );

      if (button) {
        button.disabled = true;
      }

      try {
        const {
          error
        } = await db
          .from("messages")
          .insert({
            sender_id:
              state.user.id,
            receiver_id:
              state.chat.id,
            message: text
          });

        if (error) {
          throw error;
        }

        messageDraft = "";

        if (input) {
          input.value = "";
        }

        await getMessages();
        await updateChatMessages();
        await updatePresenceActivity();

      } catch (error) {

        messageDraft = text;

        const currentInput =
          document.getElementById(
            "msg"
          );

        if (currentInput) {
          currentInput.value =
            text;

          currentInput.focus();

          try {
            currentInput.setSelectionRange(
              text.length,
              text.length
            );
          } catch {}
        }

        toast(
          error?.message ||
            "Message could not be sent."
        );

      } finally {

        sendingMessage = false;

        const currentButton =
          document.querySelector(
            ".send"
          );

        if (currentButton) {
          currentButton.disabled =
            false;
        }
      }
    };

  /* =========================================================
     FILE / PHOTO HANDLER
     ========================================================= */

  window.handleAttachments =
    async (
      event
    ) => {

      const input =
        event?.target;

      const files =
        Array.from(
          input?.files || []
        );

      captureMessageDraft();

      if (input) {
        input.value = "";
      }

      if (!files.length) {
        return;
      }

      for (
        const file of files
      ) {
        await uploadAttachment(
          file
        );
      }

      restoreMessageDraft();

      const msg =
        document.getElementById(
          "msg"
        );

      if (msg) {
        msg.focus();

        try {
          msg.setSelectionRange(
            msg.value.length,
            msg.value.length
          );
        } catch {}
      }
    };

  /* =========================================================
     CALLS
     ========================================================= */

  window.callUser =
    (
      type
    ) => {
      toast(
        `${
          type === "video"
            ? "Video"
            : "Voice"
        } calling will be connected in the WebRTC call module.`
      );
    };

  window.leaveChat =
    async () => {
      messageDraft = "";

      chatRenderToken++;

      state.chat = null;
      state.messages = [];
      state.attachments = {};
      state.attachmentUrls = {};
      state.screen = "home";

      await updatePresenceActivity();

      render();
    };

  /* =========================================================
     MOMENTS
     ========================================================= */

  function renderMoments() {
    app.innerHTML =
      layout(
        `
          <div class="screen">

            <div class="top">

              <div class="brand">
                ${icon("✦")}
                Moments
              </div>

              <button
                class="iconbtn"
                onclick="
                  document
                    .getElementById(
                      'momentFile'
                    )
                    .click()
                "
              >
                ＋
              </button>

              <input
                id="momentFile"
                class="photo-btn"
                type="file"
                accept="image/*"
                onchange="
                  addMoment(event)
                "
              >

            </div>

            <div class="content">

              ${
                state.moments.length
                  ? state.moments
                      .map(
                        (m) =>
                          `
                            <div class="moment">

                              <img
                                src="${esc(
                                  m.src
                                )}"
                              >

                              <p>

                                ${esc(
                                  m.text ||
                                    "Leo Moment"
                                )}

                                <br>

                                <span class="muted">
                                  ${new Date(
                                    m.at
                                  ).toLocaleString()}
                                </span>

                              </p>

                            </div>
                          `
                      )
                      .join("")
                  : `
                      <div class="empty">

                        <div
                          style="
                            font-size:50px
                          "
                        >
                          ✦
                        </div>

                        No moments yet.

                      </div>
                    `
              }

            </div>

          </div>
        `
      );
  }

  window.addMoment =
    (
      event
    ) => {
      const file =
        event.target?.files?.[0];

      if (!file) return;

      const reader =
        new FileReader();

      reader.onload = () => {

        const text =
          prompt(
            "Moment caption"
          ) || "";

        state.moments.unshift({
          src: reader.result,
          text,
          at: Date.now()
        });

        localStorage.setItem(
          "leo_moments",
          JSON.stringify(
            state.moments
          )
        );

        renderMoments();
      };

      reader.readAsDataURL(
        file
      );

      event.target.value = "";
    };

  /* =========================================================
     CALLS SCREEN
     ========================================================= */

  function renderCalls() {
    app.innerHTML =
      layout(
        `
          <div class="screen">

            <div class="top">

              <div class="brand">
                ${icon("☎")}
                Calls
              </div>

            </div>

            <div class="content">

              <div class="card center">

                <img
                  class="logo"
                  src="./logo.svg"
                >

                <h2>
                  Leo Calls
                </h2>

                <p class="muted">
                  Voice and video calls
                  will use WebRTC for
                  live audio and video.
                </p>

                <button
                  class="btn"
                  onclick="
                    toast(
                      'Choose a person from Chats to call'
                    )
                  "
                >
                  Start a call
                </button>

              </div>

            </div>

          </div>
        `
      );
  }

  /* =========================================================
     SETTINGS
     ========================================================= */

  function renderSettings() {
    app.innerHTML =
      layout(
        `
          <div class="screen">

            <div class="top">

              <div class="brand">
                ${icon("⚙")}
                Settings
              </div>

            </div>

            <div class="content">

              <div class="card">

                <h3>
                  Profile
                </h3>

                <div class="row">

                  <div class="avatar">
                    ${esc(
                      state.profile
                        ?.avatar ||
                        "🦁"
                    )}
                  </div>

                  <div class="grow">

                    <div class="name">
                      ${esc(
                        state.profile
                          ?.display_name ||
                          ""
                      )}
                    </div>

                    <div class="sub">
                      @${esc(
                        state.profile
                          ?.username ||
                          ""
                      )}
                    </div>

                  </div>

                </div>

              </div>

              <div class="card">

                <h3>
                  Notifications
                </h3>

                ${settingRow(
                  "messages",
                  "Messages"
                )}

                ${settingRow(
                  "calls",
                  "Calls"
                )}

                ${settingRow(
                  "moments",
                  "Moments"
                )}

              </div>

              <button
                class="btn secondary"
                onclick="
                  openNotifications()
                "
              >
                🔔 Notifications
              </button>

              <button
                class="btn secondary"
                onclick="
                  logout()
                "
              >
                Log out
              </button>

            </div>

          </div>
        `
      );
  }

  function settingRow(
    key,
    label
  ) {
    return `
      <div
        class="row"
        style="
          padding:10px 0;
          border-bottom:1px solid #222
        "
      >

        <div class="grow">
          ${label}
        </div>

        <input
          class="switch"
          type="checkbox"
          ${
            state.settings[key]
              ? "checked"
              : ""
          }
          onchange="
            toggleSetting(
              '${key}',
              this.checked
            )
          "
        >

      </div>
    `;
  }

  window.toggleSetting =
    (
      key,
      value
    ) => {
      state.settings[key] =
        value;

      localStorage.setItem(
        "leo_settings",
        JSON.stringify(
          state.settings
        )
      );
    };

  /* =========================================================
     NOTIFICATIONS
     ========================================================= */

  function addNotification(
    title,
    body
  ) {
    if (
      !state.settings.messages
    ) {
      return;
    }

    state.notifications.unshift({
      title,
      body,
      at: Date.now()
    });

    state.notifications =
      state.notifications.slice(
        0,
        50
      );

    localStorage.setItem(
      "leo_notifications",
      JSON.stringify(
        state.notifications
      )
    );

    if (
      state.screen !==
      "notifications"
    ) {
      toast(title);
    }
  }

  window.openNotifications =
    () => {
      state.screen =
        "notifications";

      messageDraft = "";

      render();
    };

  function renderNotifications() {
    app.innerHTML =
      layout(
        `
          <div class="screen">

            <div class="top">

              <div class="brand">

                <button
                  class="back"
                  onclick="
                    go('settings')
                  "
                >
                  ‹
                </button>

                ${icon("🔔")}

                Notifications

              </div>

            </div>

            <div class="content">

              ${
                state.notifications
                  .length
                  ? state.notifications
                      .map(
                        (n) =>
                          `
                            <div class="card">

                              <div class="name">
                                ${esc(
                                  n.title
                                )}
                              </div>

                              <div class="sub">
                                ${esc(
                                  n.body
                                )}
                              </div>

                              <div class="muted">
                                ${
                                  n.at
                                    ? new Date(
                                        n.at
                                      ).toLocaleString()
                                    : ""
                                }
                              </div>

                            </div>
                          `
                      )
                      .join("")
                  : `
                      <div class="empty">
                        No notifications yet.
                      </div>
                    `
              }

            </div>

          </div>
        `
      );
  }

  /* =========================================================
     MAIN RENDER
     ========================================================= */

  async function render() {
    if (!state.user) {
      renderAuth();
      return;
    }

    /*
      Profile setup has priority and is protected.
    */

    if (!state.profile) {
      state.screen = "setup";
      renderSetup();
      return;
    }

    profileFormActive = false;

    if (
      state.screen === "chat"
    ) {
      await renderChat();
      return;
    }

    if (
      state.screen === "search"
    ) {
      renderSearch();
      return;
    }

    if (
      state.screen === "moments"
    ) {
      renderMoments();
      return;
    }

    if (
      state.screen === "calls"
    ) {
      renderCalls();
      return;
    }

    if (
      state.screen === "settings"
    ) {
      renderSettings();
      return;
    }

    if (
      state.screen ===
      "notifications"
    ) {
      renderNotifications();
      return;
    }

    state.screen = "home";

    await renderHome();
  }

  /* =========================================================
     AUTH LISTENER
     ========================================================= */

  function startAuthListener() {
    if (authSubscription) {
      return;
    }

    const {
      data
    } =
      db.auth.onAuthStateChange(
        async (
          event,
          session
        ) => {

          const newUser =
            session?.user ||
            null;

          const sameUser =
            Boolean(
              state.user &&
              newUser &&
              state.user.id ===
                newUser.id
            );

          state.user =
            newUser;

          if (!state.user) {

            profileFormActive =
              false;

            messageDraft = "";
            searchDraft = "";

            state.profile = null;

            clearInterval(poll);
            clearInterval(
              presencePoll
            );

            render();

            return;
          }

          /*
            IMPORTANT:
            Supabase can fire an auth event
            while the profile form is open.

            Never rebuild the form while typing.
          */

          if (
            sameUser &&
            profileFormActive &&
            state.screen ===
              "setup"
          ) {
            return;
          }

          await loadProfile();

          if (!state.profile) {

            state.screen =
              "setup";

            profileFormActive =
              true;

            if (
              !document.getElementById(
                "uname"
              )
            ) {
              renderSetup();
            }

            return;
          }

          profileFormActive =
            false;

          if (
            !sameUser ||
            !appInitialized
          ) {
            await startPresence();
            await startMessageRealtime();
            startPolling();

            appInitialized =
              true;
          }

          if (
            state.screen ===
            "setup"
          ) {
            state.screen =
              "home";
          }

          await render();
        }
      );

    authSubscription =
      data?.subscription ||
      null;
  }

  /* =========================================================
     BOOT
     ========================================================= */

  async function boot() {
    try {

      app.innerHTML =
        layout(
          `
            <div
              class="screen center"
              style="
                justify-content:center
              "
            >

              <img
                class="logo"
                src="./logo.svg"
              >

              <h2>
                Leo Chat
              </h2>

              <p class="muted">
                Connecting...
              </p>

            </div>
          `,
          false
        );

      const {
        data,
        error
      } =
        await db.auth.getSession();

      if (error) {
        throw error;
      }

      state.user =
        data?.session?.user ||
        null;

      if (state.user) {

        await loadProfile();

        if (state.profile) {

          await startPresence();
          await startMessageRealtime();
          startPolling();

          state.screen =
            "home";

          appInitialized =
            true;

        } else {

          state.screen =
            "setup";

          profileFormActive =
            true;
        }
      }

      startAuthListener();

      await render();

    } catch (error) {

      console.error(
        "Leo Chat startup:",
        error
      );

      app.innerHTML =
        layout(
          `
            <div
              class="screen center"
              style="
                justify-content:center;
                padding:25px
              "
            >

              <img
                class="logo"
                src="./logo.svg"
              >

              <h2>
                Leo Chat
              </h2>

              <p class="muted">
                ${esc(
                  error.message ||
                    "Could not connect to Leo Chat."
                )}
              </p>

              <button
                class="btn"
                onclick="
                  location.reload()
                "
              >
                Try Again
              </button>

            </div>
          `,
          false
        );
    }
  }

  /* =========================================================
     VISIBILITY
     ========================================================= */

  window.addEventListener(
    "beforeunload",
    () => {
      if (state.user) {
        markOffline();
      }
    }
  );

  document.addEventListener(
    "visibilitychange",
    async () => {
      if (!state.user) {
        return;
      }

      if (
        document.visibilityState ===
        "visible"
      ) {

        await ensurePresence();

        if (presenceChannel) {
          try {
            await presenceChannel.track({
              user_id:
                state.user.id,

              online: true,

              activity:
                state.screen ===
                "chat"
                  ? "chatting"
                  : "online",

              at:
                new Date().toISOString()
            });
          } catch {}
        }

      } else {

        await markOffline();
      }
    }
  );

  /* =========================================================
     START
     ========================================================= */

  boot();

})();
