const socket = window.KJB_SOCKET || io({
  transports: ['websocket', 'polling'],
  timeout: 10000,
  reconnectionAttempts: 8,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});
window.KJB_SOCKET = socket;

const chatMain = document.querySelector('.chat-main');
const channel = chatMain.dataset.channel;
const channelId = parseInt(chatMain.dataset.channelId, 10);
const canSend = chatMain.dataset.canSend === 'true';
const messageList = document.getElementById('chatMessages');
const input = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const emojiSuggest = document.getElementById('emojiSuggest');
const contextMenu = document.getElementById('contextMenu');
const contextMenuBackdrop = document.getElementById('contextMenuBackdrop');
const replyBanner = document.getElementById('replyBanner');
const replyBannerLink = document.getElementById('replyBannerLink');
const replyCancel = document.getElementById('replyCancel');
const typingIndicator = document.getElementById('typingIndicator');
const imageButton = document.getElementById('imageButton');
const imageInput = document.getElementById('imageInput');
const attachmentPreview = document.getElementById('attachmentPreview');
const presenceLists = {
  online: document.querySelectorAll('[data-online-list="online"]'),
  offline: document.querySelectorAll('[data-online-list="offline"]'),
};
const emojiCatalog = Array.isArray(window.KJB_EMOJI_CATALOG) ? window.KJB_EMOJI_CATALOG : [];
const mentionCatalog = Array.isArray(window.KJB_MENTION_CATALOG) ? window.KJB_MENTION_CATALOG : [];
const emojiNames = emojiCatalog.map((emoji) => emoji.name);
const emojiImageMap = Object.fromEntries(
  emojiCatalog
    .filter((emoji) => emoji && emoji.name)
    .map((emoji) => [emoji.name, emoji.image_url || ''])
);
const presenceStorageKey = `kjb_presence_cache:${channel}`;
const pendingWatchIntervalMs = 3000;
const pendingRetryBaseMs = 2500;
const pendingRetryMaxMs = 8000;
const pendingMaxAgeMs = 45000;
let replyToId = null;
let contextMessageId = null;
let contextUserId = null;
let typing = false;
let readTimer = null;
let latestReadMessageId = null;
let lastFlushedReadMessageId = null;
let isSocketConnected = false;
let activeEmojiToken = null;
let suggestWatchSignature = '';
let editingMessageId = null;
const isMobileInputMode = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
let stickToBottom = true;
let lastMessageScrollTop = 0;
let mobileFocusKeepBottomTimer = null;
let activeMentionToken = null;
let presenceServerLoaded = false;
const pendingMessages = new Map();
let syncSnapshotLoaded = false;
let imageUploadInFlight = false;
let pendingAttachment = null;
let activeSuggestMode = null;
let activeSuggestIndex = -1;
let activeSuggestKey = '';
let pendingWatchTimer = null;

const channelItems = Array.from(document.querySelectorAll('[data-channel-slug][data-channel-id]'));
const joinedChannelSlugs = new Set(channelItems.map((item) => item.dataset.channelSlug).filter(Boolean));

function refreshSendButtonState() {
  if (!sendButton) return;
  sendButton.disabled = !canSend || !isSocketConnected || imageUploadInFlight;
  if (imageButton) {
    imageButton.disabled = !canSend || imageUploadInFlight;
  }
}

function startPendingWatchdog() {
  if (pendingWatchTimer) return;
  pendingWatchTimer = window.setInterval(() => {
    if (!pendingMessages.size) {
      window.clearInterval(pendingWatchTimer);
      pendingWatchTimer = null;
      return;
    }
    if (!socket.connected) return;
    let shouldSync = false;
    const now = Date.now();
    pendingMessages.forEach((pending, clientMessageId) => {
      const startedAt = pending.startedAtMs || now;
      const ageMs = now - startedAt;
      if (ageMs >= pendingMaxAgeMs) {
        markPendingFailed(clientMessageId);
        return;
      }
      shouldSync = true;
      const attempts = pending.attempts || 0;
      const backoffMs = Math.min(pendingRetryBaseMs * (2 ** attempts), pendingRetryMaxMs);
      const lastAttemptAt = pending.lastAttemptAtMs || 0;
      if (now - lastAttemptAt < backoffMs) return;
      pending.attempts = attempts + 1;
      pending.lastAttemptAtMs = now;
      updatePendingStatus(pending.element, 'pending');
      emitSendMessage(
        {
          channel,
          content: pending.content,
          attachment_url: pending.attachmentUrl || '',
          attachment_name: pending.attachmentName || '',
          attachment_mime: pending.attachmentMime || '',
          reply_to: pending.replyToId,
          client_message_id: clientMessageId,
        },
        clientMessageId,
        { hasRetried: true, silent: true }
      );
    });
    if (shouldSync) {
      syncCurrentChannelState();
    }
  }, pendingWatchIntervalMs);
}

function setUnreadDot(targetChannelId, isUnread) {
  if (!targetChannelId) return;
  const channelLinks = document.querySelectorAll(`a[data-channel-id="${targetChannelId}"]`);
  channelLinks.forEach((link) => {
    const existingDot = link.querySelector('.unread-dot');
    if (isUnread && !existingDot) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.setAttribute('aria-label', '읽지 않음');
      link.appendChild(dot);
      return;
    }
    if (!isUnread && existingDot) {
      existingDot.remove();
    }
  });
}

function flushReadState() {
  if (!latestReadMessageId || latestReadMessageId === lastFlushedReadMessageId) return;
  const body = new URLSearchParams({ channel, message_id: latestReadMessageId.toString() });
  fetch('/chat/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    keepalive: true,
  })
    .then(() => {
      lastFlushedReadMessageId = latestReadMessageId;
      setUnreadDot(channelId, false);
    })
    .catch(() => {});
}

function queueMarkChannelRead(messageId) {
  if (!messageId) return;
  latestReadMessageId = Math.max(latestReadMessageId || 0, messageId);
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(flushReadState, 400);
}

function updateTypingState(nextState) {
  if (typing === nextState) return;
  typing = nextState;
  socket.emit('typing', { channel, is_typing: typing });
}

function syncTypingStateFromInput() {
  if (!canSend || !input) return;
  updateTypingState(input.value.trim().length > 0);
}

function autoResizeInput() {
  if (!input) return;
  input.style.height = '40px';
  const nextHeight = Math.min(input.scrollHeight, 120);
  const isMultiline = input.value.includes('\n') || nextHeight > 40;
  input.style.height = `${isMultiline ? nextHeight : 40}px`;
}

function renderMessage(message) {
  const attachmentUrl = message.attachment_url || message.image_url || '';
  const attachmentName = message.attachment_name || '';
  const attachmentMime = message.attachment_mime || '';
  const isImageAttachment = attachmentUrl && (attachmentMime.startsWith('image/') || Boolean(message.image_url));
  const wrapper = document.createElement('div');
  wrapper.className = 'message';
  wrapper.id = `message-${message.id}`;
  wrapper.dataset.messageId = message.id;
  wrapper.dataset.userId = message.user_id;
  if (message.client_message_id) {
    wrapper.dataset.clientMessageId = message.client_message_id;
  }

  wrapper.innerHTML = `
    <a href="/profile?usr=${message.user_prefix}" class="avatar-link">
      <img src="${message.avatar}" alt="avatar">
    </a>
    <div class="message-body">
      <div class="message-meta">
        <a href="/profile?usr=${message.user_prefix}" ${message.name_color ? `style="color:${message.name_color};"` : ''}>${message.user_name}</a>
        ${message.accessory_image ? `<img src="${message.accessory_image}" class="name-accessory" alt="accessory">` : ''}
        <span>${message.created_at}</span>
        ${message.updated_at && message.updated_at !== message.created_at ? '<span class="edited">수정됨</span>' : ''}
      </div>
      ${message.reply_to && message.reply_to_id ? `<a class="reply-preview" href="#message-${message.reply_to_id}" data-message-target="${message.reply_to_id}">↳ ${message.reply_to}</a>` : ''}
      ${message.reply_to && !message.reply_to_id ? `<div class="reply-preview">↳ ${message.reply_to}</div>` : ''}
      <div class="message-content">${message.rendered_content || message.content}</div>
      ${attachmentUrl && isImageAttachment ? `<a class="message-image-link" href="${attachmentUrl}" target="_blank" rel="noopener noreferrer"><img class="message-image" src="${attachmentUrl}" alt="첨부 이미지"></a>` : ''}
      ${attachmentUrl && !isImageAttachment ? `
        <a class="message-file-link" href="${attachmentUrl}" target="_blank" rel="noopener noreferrer">
          <span class="message-file-icon">파일</span>
          <span class="message-file-name">${attachmentName || attachmentUrl.split('/').pop()}</span>
        </a>
      ` : ''}
    </div>
  `;
  return wrapper;
}

function getLatestRenderedMessageId() {
  const messageNodes = messageList?.querySelectorAll('.message[data-message-id]') || [];
  const lastMessage = messageNodes.length ? messageNodes[messageNodes.length - 1] : null;
  if (!lastMessage) return 0;
  return parseInt(lastMessage.dataset.messageId || '0', 10) || 0;
}

function getMessageContentById(messageId) {
  const element = messageList.querySelector(`[data-message-id="${messageId}"]`);
  if (!element) return '';
  const text = (element.querySelector('.message-content')?.textContent || '').trim();
  if (text) return text;
  if (element.querySelector('.message-image')) return '[사진]';
  if (element.querySelector('.message-file-link')) return '[파일]';
  return '';
}

function createClientMessageId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearPendingAttachment() {
  pendingAttachment = null;
  if (attachmentPreview) {
    attachmentPreview.replaceChildren();
    attachmentPreview.classList.add('hidden');
  }
  if (imageInput) {
    imageInput.value = '';
  }
}

function renderAttachmentPreview() {
  if (!attachmentPreview) return;
  if (!pendingAttachment) {
    attachmentPreview.replaceChildren();
    attachmentPreview.classList.add('hidden');
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'attachment-preview-card';
  const meta = document.createElement('div');
  meta.className = 'attachment-preview-meta';
  if (pendingAttachment.isImage) {
    const image = document.createElement('img');
    image.src = pendingAttachment.url;
    image.alt = pendingAttachment.name || '첨부 이미지';
    wrapper.appendChild(image);
    meta.innerHTML = `
      <strong>사진 첨부</strong>
      <span>${pendingAttachment.name || ''}</span>
    `;
  } else {
    const fileBadge = document.createElement('div');
    fileBadge.className = 'attachment-file-badge';
    fileBadge.textContent = 'FILE';
    wrapper.appendChild(fileBadge);
    meta.innerHTML = `
      <strong>파일 첨부</strong>
      <span>${pendingAttachment.name || ''}</span>
    `;
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn secondary attachment-remove';
  remove.textContent = '제거';
  remove.addEventListener('click', clearPendingAttachment);
  wrapper.appendChild(meta);
  wrapper.appendChild(remove);
  attachmentPreview.replaceChildren(wrapper);
  attachmentPreview.classList.remove('hidden');
}

async function uploadChatImage(file) {
  if (!file || !canSend) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('channel', channel);
  imageUploadInFlight = true;
  refreshSendButtonState();
  try {
    const response = await fetch('/chat/upload', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.ok || !payload.url) {
      throw new Error(payload?.error || 'upload_failed');
    }
    pendingAttachment = {
      url: payload.url,
      name: file.name,
      mime: payload.mime || file.type || '',
      isImage: Boolean(payload.is_image),
    };
    renderAttachmentPreview();
  } catch (error) {
    alert('사진 업로드에 실패했습니다. 파일 형식이나 용량을 확인해주세요.');
    clearPendingAttachment();
  } finally {
    imageUploadInFlight = false;
    refreshSendButtonState();
  }
}

function renderPendingMessage(payload) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message message-pending';
  wrapper.dataset.clientMessageId = payload.clientMessageId;
  wrapper.dataset.userId = window.KJB_CURRENT_USER_ID;

  const avatarLink = document.createElement('a');
  avatarLink.className = 'avatar-link';
  avatarLink.href = `/profile?usr=${window.KJB_CURRENT_USER_PREFIX || ''}`;
  const avatar = document.createElement('img');
  avatar.src = window.KJB_CURRENT_USER_AVATAR || '/static/images/default-avatar.svg';
  avatar.alt = 'avatar';
  avatarLink.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'message-body';

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const nameLink = document.createElement('a');
  nameLink.href = `/profile?usr=${window.KJB_CURRENT_USER_PREFIX || ''}`;
  nameLink.textContent = window.KJB_CURRENT_USER_NAME || 'Me';
  meta.appendChild(nameLink);

  const timestamp = document.createElement('span');
  timestamp.textContent = '전송 중...';
  meta.appendChild(timestamp);

  body.appendChild(meta);

  if (payload.replyToId) {
    const replyPreview = document.createElement('div');
    replyPreview.className = 'reply-preview';
    replyPreview.textContent = `↳ ${getMessageContentById(payload.replyToId) || '답장 대상'}`;
    body.appendChild(replyPreview);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = payload.content;
  body.appendChild(content);

  if (payload.attachmentUrl) {
    if (payload.isImage) {
      const imageLink = document.createElement('a');
      imageLink.className = 'message-image-link';
      imageLink.href = payload.attachmentUrl;
      imageLink.target = '_blank';
      imageLink.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = payload.attachmentUrl;
      image.alt = '첨부 이미지';
      imageLink.appendChild(image);
      body.appendChild(imageLink);
    } else {
      const fileLink = document.createElement('a');
      fileLink.className = 'message-file-link';
      fileLink.href = payload.attachmentUrl;
      fileLink.target = '_blank';
      fileLink.rel = 'noopener noreferrer';
      const icon = document.createElement('span');
      icon.className = 'message-file-icon';
      icon.textContent = '파일';
      const name = document.createElement('span');
      name.className = 'message-file-name';
      name.textContent = payload.attachmentName || payload.attachmentUrl.split('/').pop();
      fileLink.appendChild(icon);
      fileLink.appendChild(name);
      body.appendChild(fileLink);
    }
  }

  const status = document.createElement('div');
  status.className = 'message-status';
  status.dataset.role = 'status';
  status.innerHTML = '<span>전송 중</span>';
  body.appendChild(status);

  wrapper.appendChild(avatarLink);
  wrapper.appendChild(body);
  return wrapper;
}

function updatePendingStatus(wrapper, state) {
  if (!wrapper) return;
  wrapper.classList.remove('message-pending', 'message-failed');
  if (state === 'pending') {
    wrapper.classList.add('message-pending');
  } else if (state === 'failed') {
    wrapper.classList.add('message-failed');
  }
  const status = wrapper.querySelector('[data-role="status"]');
  const retryButton = wrapper.querySelector('[data-action="retry-send"]');
  if (state === 'pending') {
    if (status) status.innerHTML = '<span>전송 중</span>';
    if (retryButton) retryButton.remove();
  } else if (state === 'failed') {
    if (status) status.innerHTML = '<span>전송 실패</span>';
    if (!retryButton) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary message-retry';
      button.dataset.action = 'retry-send';
      button.textContent = '다시 보내기';
      status?.appendChild(button);
    }
  }
}

function finalizePendingMessage(clientMessageId, message) {
  const pending = pendingMessages.get(clientMessageId);
  if (pending) {
    const replacement = renderMessage(message);
    pending.element.replaceWith(replacement);
    pendingMessages.delete(clientMessageId);
    return replacement;
  }
  const existing = document.getElementById(`message-${message.id}`);
  if (existing) {
    return existing;
  }
  const element = renderMessage(message);
  messageList.appendChild(element);
  return element;
}

function markPendingFailed(clientMessageId) {
  const pending = pendingMessages.get(clientMessageId);
  if (!pending) return;
  updatePendingStatus(pending.element, 'failed');
  pending.failed = true;
}

function markPendingSent(clientMessageId, message) {
  const pending = pendingMessages.get(clientMessageId);
  if (pending) {
    const replacement = message ? renderMessage(message) : renderMessage({
      id: pending.fallbackId || Date.now(),
      channel_id: channelId,
      user_id: window.KJB_CURRENT_USER_ID,
      user_name: window.KJB_CURRENT_USER_NAME || 'Me',
      user_prefix: window.KJB_CURRENT_USER_PREFIX || '',
      avatar: window.KJB_CURRENT_USER_AVATAR || '/static/images/default-avatar.svg',
      content: pending.content,
      rendered_content: pending.element.querySelector('.message-content')?.innerHTML || '',
      reply_to: pending.replyToText || null,
      reply_to_id: pending.replyToId || null,
      is_deleted: false,
      name_color: null,
      accessory_image: null,
      created_at: pending.createdAt || '전송 완료',
      updated_at: null,
      client_message_id: clientMessageId,
    });
    pending.element.replaceWith(replacement);
    pendingMessages.delete(clientMessageId);
    return replacement;
  }
  if (message) {
    const existing = document.getElementById(`message-${message.id}`);
    if (existing) return existing;
    const element = renderMessage(message);
    messageList.appendChild(element);
    return element;
  }
  return null;
}

if (imageButton && imageInput) {
  imageButton.addEventListener('click', () => {
    if (canSend && !imageUploadInFlight) {
      imageInput.click();
    }
  });
  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    uploadChatImage(file);
  });
}

function isNearBottom() {
  if (!messageList) return true;
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 24;
}

function scrollMessagesToBottom(force = false) {
  if (!messageList) return;
  if (!force && !stickToBottom) return;
  messageList.scrollTop = messageList.scrollHeight;
  lastMessageScrollTop = messageList.scrollTop;
}

function scrollToMessageFromHash() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#message-')) return;
  const target = document.querySelector(hash);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, 0);
}

function goToMessage(messageId) {
  if (!messageId) return;
  const target = document.getElementById(`message-${messageId}`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, 0);
}

function keepBottomOnMobileFocus() {
  if (!isMobileInputMode) return;
  if (mobileFocusKeepBottomTimer) {
    window.clearTimeout(mobileFocusKeepBottomTimer);
  }
  scrollMessagesToBottom(true);
  mobileFocusKeepBottomTimer = window.setTimeout(() => {
    scrollMessagesToBottom(true);
  }, 220);
}

function appendMessage(message) {
  const element = renderMessage(message);
  messageList.appendChild(element);
  scrollMessagesToBottom();
  setUnreadDot(channelId, false);
  queueMarkChannelRead(message.id);
}

function upsertIncomingMessage(message) {
  if (!message) return;
  if (message.channel_id !== channelId) {
    setUnreadDot(message.channel_id, true);
    return;
  }

  if (message.client_message_id && pendingMessages.has(message.client_message_id)) {
    const element = finalizePendingMessage(message.client_message_id, message);
    if (element) {
      scrollMessagesToBottom();
      queueMarkChannelRead(message.id);
    }
    return;
  }

  const existing = document.getElementById(`message-${message.id}`);
  if (existing) return;
  appendMessage(message);
}

function renderPresenceItem(user, isOnline) {
  const li = document.createElement('li');
  li.className = `online-item${isOnline ? ' is-online' : ' is-offline'}`;
  li.innerHTML = `
    <a href="/profile?usr=${user.email_prefix}"><img src="${user.avatar}" alt="avatar"></a>
    <a href="/profile?usr=${user.email_prefix}">${user.name}</a>
    ${user.accessory_image ? `<img src="${user.accessory_image}" class="name-accessory" alt="accessory">` : ''}
  `;
  const nameLink = li.querySelectorAll('a')[1];
  if (nameLink && user.name_color) nameLink.style.color = user.name_color;
  return li;
}

function loadPresenceCache() {
  try {
    const raw = localStorage.getItem(presenceStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      online: Array.isArray(parsed.online) ? parsed.online : [],
      offline: Array.isArray(parsed.offline) ? parsed.offline : [],
    };
  } catch (_) {
    return null;
  }
}

function savePresenceCache(payload) {
  try {
    localStorage.setItem(presenceStorageKey, JSON.stringify({
      online: Array.isArray(payload?.online) ? payload.online : [],
      offline: Array.isArray(payload?.offline) ? payload.offline : [],
    }));
  } catch (_) {}
}

function renderPresencePlaceholders() {
  const placeholder = { name: '불러오는 중', email_prefix: 'loading', avatar: '/static/images/default-avatar.svg' };
  const offlinePlaceholder = { ...placeholder };
  presenceLists.online.forEach((list) => list.replaceChildren(renderPresenceItem(placeholder, true)));
  presenceLists.offline.forEach((list) => list.replaceChildren(renderPresenceItem(offlinePlaceholder, false)));
}

function renderPresenceLists(payload) {
  const onlineUsers = Array.isArray(payload?.online) ? payload.online : [];
  const offlineUsers = Array.isArray(payload?.offline) ? payload.offline : [];

  const onlineFragment = document.createDocumentFragment();
  onlineUsers.forEach((user) => onlineFragment.appendChild(renderPresenceItem(user, true)));
  const offlineFragment = document.createDocumentFragment();
  offlineUsers.forEach((user) => offlineFragment.appendChild(renderPresenceItem(user, false)));

  const onlineContent = onlineUsers.length
    ? onlineFragment.cloneNode(true)
    : (() => {
        const empty = document.createElement('li');
        empty.className = 'presence-empty';
        empty.textContent = '없음';
        return empty;
      })();
  const offlineContent = offlineUsers.length
    ? offlineFragment.cloneNode(true)
    : (() => {
        const empty = document.createElement('li');
        empty.className = 'presence-empty';
        empty.textContent = '없음';
        return empty;
      })();

  presenceLists.online.forEach((list) => list.replaceChildren(onlineContent.cloneNode(true)));
  presenceLists.offline.forEach((list) => list.replaceChildren(offlineContent.cloneNode(true)));
}

function updatePresenceLists(payload) {
  const onlineUsers = Array.isArray(payload?.online) ? payload.online : [];
  const offlineUsers = Array.isArray(payload?.offline) ? payload.offline : [];
  const hasAnyUsers = onlineUsers.length > 0 || offlineUsers.length > 0;

  if (!presenceServerLoaded && !hasAnyUsers) {
    const cachedPresence = loadPresenceCache();
    if (cachedPresence && (cachedPresence.online.length > 0 || cachedPresence.offline.length > 0)) {
      renderPresenceLists(cachedPresence);
      return;
    }
  }

  presenceServerLoaded = true;
  if (hasAnyUsers) {
    savePresenceCache({ online: onlineUsers, offline: offlineUsers });
  }
  renderPresenceLists({ online: onlineUsers, offline: offlineUsers });
}

function initPresenceLists() {
  const cachedPresence = loadPresenceCache();
  if (cachedPresence) {
    renderPresenceLists(cachedPresence);
    return;
  }
  renderPresencePlaceholders();
}

initPresenceLists();

function closeContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenuBackdrop?.classList.add('hidden');
  contextMenuBackdrop?.setAttribute('aria-hidden', 'true');
}

function openContextMenu(x, y) {
  contextMenu.style.top = `${y}px`;
  contextMenu.style.left = `${x}px`;
  contextMenu.classList.remove('hidden');
  contextMenuBackdrop?.classList.remove('hidden');
  contextMenuBackdrop?.setAttribute('aria-hidden', 'false');
}

function cancelInlineEdit() {
  if (!editingMessageId) return;
  const messageElement = messageList.querySelector(`[data-message-id="${editingMessageId}"]`);
  if (!messageElement) {
    editingMessageId = null;
    return;
  }
  const contentEl = messageElement.querySelector('.message-content');
  const editor = messageElement.querySelector('.message-edit-inline');
  editor?.remove();
  contentEl?.classList.remove('hidden');
  editingMessageId = null;
}

function startInlineEdit(messageId) {
  const messageElement = messageList.querySelector(`[data-message-id="${messageId}"]`);
  if (!messageElement) return;
  const ownerId = parseInt(messageElement.dataset.userId || '0', 10);
  if (ownerId !== window.KJB_CURRENT_USER_ID) return;

  if (editingMessageId && editingMessageId !== messageId) {
    cancelInlineEdit();
  }
  if (editingMessageId === messageId) return;

  const contentEl = messageElement.querySelector('.message-content');
  if (!contentEl) return;
  const initialText = (contentEl.textContent || '').trim();

  const editor = document.createElement('div');
  editor.className = 'message-edit-inline';
  editor.innerHTML = `
    <textarea class="message-edit-input">${initialText}</textarea>
    <div class="message-edit-actions">
      <button type="button" class="btn secondary" data-action="cancel">취소</button>
      <button type="button" class="btn primary" data-action="save">저장</button>
    </div>
  `;

  const textarea = editor.querySelector('.message-edit-input');
  const cancelBtn = editor.querySelector('[data-action="cancel"]');
  const saveBtn = editor.querySelector('[data-action="save"]');

  cancelBtn.addEventListener('click', cancelInlineEdit);
  saveBtn.addEventListener('click', () => {
    const nextContent = (textarea.value || '').trim();
    if (!nextContent) return;
    socket.emit('edit_message', { message_id: messageId, content: nextContent });
  });

  contentEl.classList.add('hidden');
  contentEl.insertAdjacentElement('afterend', editor);
  editingMessageId = messageId;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function closeEmojiSuggest() {
  if (!emojiSuggest) return;
  emojiSuggest.classList.remove('open');
  emojiSuggest.setAttribute('aria-hidden', 'true');
  emojiSuggest.hidden = true;
  emojiSuggest.style.display = 'none';
  emojiSuggest.replaceChildren();
  activeEmojiToken = null;
  activeMentionToken = null;
  activeSuggestMode = null;
  activeSuggestIndex = -1;
  activeSuggestKey = '';
}

function getSuggestButtons() {
  if (!emojiSuggest) return [];
  return Array.from(emojiSuggest.querySelectorAll('[data-suggest-index]'));
}

function setSuggestSelection(nextIndex) {
  const buttons = getSuggestButtons();
  if (!buttons.length) {
    activeSuggestIndex = -1;
    activeSuggestKey = '';
    return;
  }
  const normalized = ((nextIndex % buttons.length) + buttons.length) % buttons.length;
  activeSuggestIndex = normalized;
  activeSuggestKey = buttons[normalized]?.dataset.suggestKey || '';
  buttons.forEach((button, index) => {
    const active = index === normalized;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  buttons[normalized]?.scrollIntoView({ block: 'nearest' });
}

function moveSuggestSelection(delta) {
  const buttons = getSuggestButtons();
  if (!buttons.length) return;
  const currentIndex = activeSuggestIndex >= 0 ? activeSuggestIndex : 0;
  setSuggestSelection(currentIndex + delta);
}

function acceptActiveSuggestion() {
  const buttons = getSuggestButtons();
  if (!buttons.length) return false;
  const index = activeSuggestIndex >= 0 ? activeSuggestIndex : 0;
  const button = buttons[index];
  if (!button) return false;
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  return true;
}

function preserveSuggestSelection(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  if (activeSuggestKey) {
    const byKey = items.findIndex((item) => item && item.suggestKey === activeSuggestKey);
    if (byKey >= 0) return byKey;
  }
  if (activeSuggestIndex >= 0 && activeSuggestIndex < items.length) {
    return activeSuggestIndex;
  }
  return 0;
}

function getActiveEmojiToken() {
  const cursor = input.selectionStart ?? 0;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(?:^|\s):([a-zA-Z0-9_\-]*)$/);
  if (!match) return null;
  const keyword = match[1] || '';
  const tokenStart = cursor - keyword.length - 1;
  return { keyword, tokenStart, cursor };
}

function getActiveMentionToken() {
  const cursor = input.selectionStart ?? 0;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([a-zA-Z0-9._\-]*)$/);
  if (!match) return null;
  const keyword = match[1] || '';
  const tokenStart = cursor - keyword.length - 1;
  return { keyword, tokenStart, cursor };
}

function insertEmojiName(name) {
  if (!activeEmojiToken) return;
  const text = input.value;
  const prefix = text.slice(0, activeEmojiToken.tokenStart);
  const suffix = text.slice(activeEmojiToken.cursor);
  const inserted = `:${name}:`;
  const needsSpace = suffix.length > 0 && !/^\s/.test(suffix);
  input.value = `${prefix}${inserted}${needsSpace ? ' ' : ''}${suffix}`;
  const nextPos = (prefix + inserted + (needsSpace ? ' ' : '')).length;
  input.focus();
  input.setSelectionRange(nextPos, nextPos);
  closeEmojiSuggest();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function insertMentionPrefix(emailPrefix) {
  if (!activeMentionToken) return;
  const text = input.value;
  const prefix = text.slice(0, activeMentionToken.tokenStart);
  const suffix = text.slice(activeMentionToken.cursor);
  const inserted = `@${emailPrefix}`;
  const needsSpace = suffix.length > 0 && !/^\s/.test(suffix);
  input.value = `${prefix}${inserted}${needsSpace ? ' ' : ''}${suffix}`;
  const nextPos = (prefix + inserted + (needsSpace ? ' ' : '')).length;
  input.focus();
  input.setSelectionRange(nextPos, nextPos);
  closeEmojiSuggest();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function openEmojiSuggest(items) {
  if (!Array.isArray(items) || items.length === 0) {
    closeEmojiSuggest();
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((name, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-suggest-item';
    button.dataset.suggestIndex = String(index);
    button.dataset.suggestKey = name;
    const label = document.createElement('span');
    label.textContent = `:${name}:`;
    button.appendChild(label);
    const imageUrl = emojiImageMap[name];
    if (imageUrl) {
      const preview = document.createElement('img');
      preview.className = 'emoji-suggest-preview';
      preview.src = imageUrl.startsWith('/') ? imageUrl : `/cdn/${imageUrl}`;
      preview.alt = name;
      button.appendChild(preview);
    }
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      insertEmojiName(name);
    });
    button.addEventListener('mouseenter', () => setSuggestSelection(index));
    fragment.appendChild(button);
  });
  emojiSuggest.replaceChildren(fragment);
  emojiSuggest.hidden = false;
  emojiSuggest.style.display = 'flex';
  emojiSuggest.classList.add('open');
  emojiSuggest.setAttribute('aria-hidden', 'false');
  activeSuggestMode = 'emoji';
  setSuggestSelection(preserveSuggestSelection(items));
}

function openMentionSuggest(items) {
  if (!Array.isArray(items) || items.length === 0) {
    closeEmojiSuggest();
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((user, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-suggest-item';
    button.dataset.suggestIndex = String(index);
    button.dataset.suggestKey = user.email_prefix || '';
    const label = document.createElement('span');
    label.textContent = `${user.name} (@${user.email_prefix})`;
    button.appendChild(label);
    if (user.avatar_url) {
      const preview = document.createElement('img');
      preview.className = 'emoji-suggest-preview';
      preview.src = user.avatar_url.startsWith('/') ? user.avatar_url : `/cdn/${user.avatar_url}`;
      preview.alt = user.name || user.email_prefix;
      button.appendChild(preview);
    }
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      insertMentionPrefix(user.email_prefix);
    });
    button.addEventListener('mouseenter', () => setSuggestSelection(index));
    fragment.appendChild(button);
  });
  emojiSuggest.replaceChildren(fragment);
  emojiSuggest.hidden = false;
  emojiSuggest.style.display = 'flex';
  emojiSuggest.classList.add('open');
  emojiSuggest.setAttribute('aria-hidden', 'false');
  activeSuggestMode = 'mention';
  setSuggestSelection(preserveSuggestSelection(items));
}

function updateMentionSuggest() {
  if (!input || input.disabled || mentionCatalog.length === 0) {
    return false;
  }
  const mentionToken = getActiveMentionToken();
  if (!mentionToken) {
    return false;
  }
  activeMentionToken = mentionToken;
  activeEmojiToken = null;
  const q = mentionToken.keyword.toLowerCase();
  const list = mentionCatalog
    .filter((user) => user && user.email_prefix)
    .filter((user) => {
      const name = (user.name || "").toLowerCase();
      const prefix = (user.email_prefix || "").toLowerCase();
      return name.includes(q) || prefix.includes(q);
    })
    .slice(0, 24);
  if (!list.length) {
    return false;
  }
  openMentionSuggest(list);
  return true;
}

function updateEmojiSuggest() {
  if (!input || input.disabled) {
    closeEmojiSuggest();
    return;
  }
  if (input.value.length === 0 || input.value.trim().length === 0) {
    closeEmojiSuggest();
    return;
  }
  if (updateMentionSuggest()) {
    return;
  }

  const token = getActiveEmojiToken();
  if (!token) {
    closeEmojiSuggest();
    return;
  }
  activeEmojiToken = token;
  activeMentionToken = null;
  const q = token.keyword.toLowerCase();
  const list = emojiNames
    .filter((name) => name.toLowerCase().includes(q))
    .slice(0, 24);
  if (!list.length) {
    closeEmojiSuggest();
    return;
  }
  openEmojiSuggest(list);
}

function startEmojiSuggestWatcher() {
  if (!input) return;
  window.setInterval(() => {
    const signature = `${input.value}::${input.selectionStart ?? -1}::${document.activeElement === input}`;
    if (signature === suggestWatchSignature) return;
    suggestWatchSignature = signature;
    if (document.activeElement !== input) {
      closeEmojiSuggest();
      return;
    }
    updateEmojiSuggest();
  }, 120);
}

function applyUnreadSnapshot(unreadChannelIds) {
  const unreadSet = new Set((unreadChannelIds || []).map((value) => Number(value)));
  channelItems.forEach((item) => {
    const channelIdValue = Number(item.dataset.channelId || 0);
    if (!channelIdValue) return;
    setUnreadDot(channelIdValue, unreadSet.has(channelIdValue));
  });
}

function syncCurrentChannelState() {
  if (!socket.connected) return;
  socket.emit(
    'sync_channel',
    { channel, after_message_id: getLatestRenderedMessageId() },
    (response) => {
      if (!response || !response.ok) return;
      if (Array.isArray(response.unread_channel_ids)) {
        applyUnreadSnapshot(response.unread_channel_ids);
      }
      (response.messages || []).forEach((message) => upsertIncomingMessage(message));
      syncSnapshotLoaded = true;
    }
  );
}

socket.on('connect', () => {
  isSocketConnected = true;
  joinedChannelSlugs.forEach((slug) => socket.emit('join', { channel: slug }));
  refreshSendButtonState();
  syncTypingStateFromInput();
  syncCurrentChannelState();
});

socket.on('disconnect', () => {
  isSocketConnected = false;
  refreshSendButtonState();
  updateTypingState(false);
});

socket.on('connect_error', () => {
  isSocketConnected = false;
  refreshSendButtonState();
});

socket.on('online_update', (payload) => updatePresenceLists(payload));

socket.on('sync_snapshot', (payload) => {
  if (!payload) return;
  if (Array.isArray(payload.unread_channel_ids)) {
    applyUnreadSnapshot(payload.unread_channel_ids);
  }
  syncSnapshotLoaded = true;
});

socket.on('typing_update', (payload) => {
  if (!payload || payload.channel !== channel) return;
  const others = (payload.users || []).filter((user) => user.id !== window.KJB_CURRENT_USER_ID);
  if (!others.length) {
    typingIndicator.classList.add('hidden');
    typingIndicator.textContent = '';
    return;
  }
  const names = others.map((user) => user.name);
  typingIndicator.textContent = names.length === 1 ? `${names[0]} 입력 중...` : `${names[0]} 외 ${names.length - 1}명 입력 중...`;
  typingIndicator.classList.remove('hidden');
});

socket.on('new_message', (message) => {
  upsertIncomingMessage(message);
});

socket.on('message_updated', (message) => {
  const element = messageList.querySelector(`[data-message-id="${message.id}"]`);
  if (!element) return;
  if (editingMessageId && Number(editingMessageId) === Number(message.id)) {
    cancelInlineEdit();
  }
  element.querySelector('.message-content').innerHTML = message.rendered_content || message.content;
  const meta = element.querySelector('.message-meta');
  if (!meta.querySelector('.edited')) {
    const edited = document.createElement('span');
    edited.className = 'edited';
    edited.textContent = '수정됨';
    meta.appendChild(edited);
  }
  scrollMessagesToBottom();
});

socket.on('message_deleted', (payload) => {
  const element = messageList.querySelector(`[data-message-id="${payload.message_id}"]`);
  if (!element) return;
  if (editingMessageId && Number(editingMessageId) === Number(payload.message_id)) {
    cancelInlineEdit();
  }
  if (replyToId && Number(replyToId) === Number(payload.message_id)) {
    replyToId = null;
    replyBanner.classList.add('hidden');
    replyBannerLink.textContent = '';
    replyBannerLink.href = '#';
  }
  element.remove();
  scrollMessagesToBottom(true);
});

function emitSendMessage(payload, clientMessageId, options = {}) {
  const hasRetried = Boolean(options.hasRetried);
  const silent = Boolean(options.silent);
  socket.timeout(12000).emit('send_message', payload, (err, response) => {
    if ((err || !response || !response.ok) && !hasRetried && socket.connected) {
      emitSendMessage(payload, clientMessageId, { hasRetried: true, silent });
      return;
    }

    if (err || !response || !response.ok) {
      if (!silent) {
        markPendingFailed(clientMessageId);
      }
      window.setTimeout(syncCurrentChannelState, 500);
      if (!silent) {
        alert('메시지 전송이 지연되거나 실패했습니다. 네트워크 상태를 확인해주세요.');
      }
      return;
    }

    const message = response.message || null;
    if (message) {
      markPendingSent(clientMessageId, message);
    } else {
      const pending = pendingMessages.get(clientMessageId);
      if (pending) {
        pending.element.classList.remove('message-pending', 'message-failed');
      }
    }

    pendingMessages.delete(clientMessageId);
  });
}

function keepKeyboardOpenOnMobile(event) {
  if (!isMobileInputMode) return;
  window.setTimeout(() => input.focus(), 0);
}

sendButton.addEventListener('pointerdown', keepKeyboardOpenOnMobile);
sendButton.addEventListener('mousedown', keepKeyboardOpenOnMobile);
sendButton.addEventListener('touchstart', keepKeyboardOpenOnMobile, { passive: true });

sendButton.addEventListener('click', () => {
  if (!canSend || !socket.connected) return;
  if (isMobileInputMode) {
    input.focus();
  }
  const content = input.value.trim();
  if (!content && !pendingAttachment?.url) return;
  const pendingReplyId = replyToId;
  const attachmentUrl = pendingAttachment?.url || '';
  const attachmentName = pendingAttachment?.name || '';
  const attachmentMime = pendingAttachment?.mime || '';
  const isImage = Boolean(pendingAttachment?.isImage);
  const clientMessageId = createClientMessageId();
  const pendingElement = renderPendingMessage({
    content,
    replyToId: pendingReplyId,
    clientMessageId,
    attachmentUrl,
    attachmentName,
    attachmentMime,
    isImage,
  });
  messageList.appendChild(pendingElement);
  pendingMessages.set(clientMessageId, {
    element: pendingElement,
    content,
    replyToId: pendingReplyId,
    attachmentUrl,
    attachmentName,
    attachmentMime,
    isImage,
    startedAtMs: Date.now(),
    lastAttemptAtMs: Date.now(),
    attempts: 0,
    createdAt: '전송 중',
  });
  startPendingWatchdog();
  scrollMessagesToBottom(true);
  input.value = '';
  autoResizeInput();
  clearPendingAttachment();
  replyToId = null;
  replyBanner.classList.add('hidden');
  replyBannerLink.textContent = '';
  replyBannerLink.href = '#';
  updateTypingState(false);
  closeEmojiSuggest();
  if (isMobileInputMode) {
    input.focus();
  }
  emitSendMessage(
    {
      channel,
      content,
      attachment_url: attachmentUrl,
      attachment_name: attachmentName,
      attachment_mime: attachmentMime,
      reply_to: pendingReplyId,
      client_message_id: clientMessageId,
    },
    clientMessageId
  );
});

input.addEventListener('input', () => {
  if (!canSend) return;
  autoResizeInput();
  const hasValue = input.value.trim().length > 0;
  updateTypingState(hasValue);
  updateEmojiSuggest();
});

input.addEventListener('click', updateEmojiSuggest);
input.addEventListener('keyup', (event) => {
  const suggestOpen = emojiSuggest && emojiSuggest.classList.contains('open');
  if (suggestOpen && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
    return;
  }
  updateEmojiSuggest();
});
input.addEventListener('focus', keepBottomOnMobileFocus);
input.addEventListener('blur', () => {
  setTimeout(closeEmojiSuggest, 120);
});

input.addEventListener('keydown', (event) => {
  const suggestOpen = emojiSuggest && emojiSuggest.classList.contains('open');
  if (suggestOpen) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSuggestSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSuggestSelection(-1);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (acceptActiveSuggestion()) return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (acceptActiveSuggestion()) return;
    }
  }

  if (event.key === 'Enter') {
    if (isMobileInputMode) {
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      sendButton.click();
      return;
    }
  }

  if (event.key === 'Escape') {
    closeEmojiSuggest();
  }
});

messageList.addEventListener('contextmenu', (event) => {
  const messageElement = event.target.closest('.message');
  if (!messageElement) return;
  event.preventDefault();
  contextMessageId = messageElement.dataset.messageId;
  contextUserId = parseInt(messageElement.dataset.userId, 10);
  const isOwner = contextUserId === window.KJB_CURRENT_USER_ID;
  contextMenu.querySelector('[data-action="edit"]').style.display = isOwner ? 'block' : 'none';
  contextMenu.querySelector('[data-action="delete"]').style.display = (isOwner || window.KJB_IS_ADMIN) ? 'block' : 'none';
  openContextMenu(event.clientX, event.clientY);
});

function handleGlobalDismiss(event) {
  if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(event.target)) {
    closeContextMenu();
  }
  if (emojiSuggest && !emojiSuggest.contains(event.target) && event.target !== input) {
    closeEmojiSuggest();
  }
}

document.addEventListener('pointerdown', handleGlobalDismiss, true);
document.addEventListener('mousedown', handleGlobalDismiss, true);
document.addEventListener('touchstart', handleGlobalDismiss, true);
document.addEventListener('click', handleGlobalDismiss, true);
contextMenuBackdrop?.addEventListener('click', closeContextMenu);
replyCancel?.addEventListener('click', () => {
  replyToId = null;
  replyBannerLink.textContent = '';
  replyBannerLink.href = '#';
  replyBanner.classList.add('hidden');
});

window.addEventListener('beforeunload', () => {
  socket.emit('typing', { channel, is_typing: false });
  socket.emit('leave', { channel });
  flushReadState();
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-message-target]');
  if (!target) return;
  event.preventDefault();
  goToMessage(target.dataset.messageTarget);
});

messageList.addEventListener('click', (event) => {
  const retryButton = event.target.closest('[data-action="retry-send"]');
  if (!retryButton) return;
  const pendingElement = retryButton.closest('.message');
  if (!pendingElement) return;
  const clientMessageId = pendingElement.dataset.clientMessageId;
  const pending = clientMessageId ? pendingMessages.get(clientMessageId) : null;
  if (!pending) return;
  updatePendingStatus(pending.element, 'pending');
  pending.failed = false;
  pending.lastAttemptAtMs = Date.now();
  pending.attempts = (pending.attempts || 0) + 1;
  startPendingWatchdog();
  emitSendMessage(
    {
      channel,
      content: pending.content,
      attachment_url: pending.attachmentUrl || '',
      attachment_name: pending.attachmentName || '',
      attachment_mime: pending.attachmentMime || '',
      reply_to: pending.replyToId,
      client_message_id: clientMessageId,
    },
    clientMessageId,
    { hasRetried: true, silent: false }
  );
});

replyBannerLink?.addEventListener('click', (event) => {
  event.preventDefault();
  const href = replyBannerLink.getAttribute('href') || '';
  const match = href.match(/#message-(\d+)/);
  if (match) {
    goToMessage(match[1]);
  }
});

contextMenu.addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  if (action === 'reply') {
    replyToId = contextMessageId;
    const messageElement = messageList.querySelector(`[data-message-id="${contextMessageId}"]`);
    const content = messageElement ? messageElement.querySelector('.message-content').textContent : '';
    replyBannerLink.textContent = `답장: ${content}`;
    replyBannerLink.href = `#message-${contextMessageId}`;
    replyBanner.classList.remove('hidden');
  }
  if (action === 'edit') {
    startInlineEdit(contextMessageId);
  }
  if (action === 'delete') {
    if (confirm('메시지를 삭제할까요?')) socket.emit('delete_message', { message_id: contextMessageId });
  }
  closeContextMenu();
});

messageList.addEventListener('scroll', () => {
  const currentTop = messageList.scrollTop;
  const scrollingUp = currentTop < lastMessageScrollTop - 1;
  if (scrollingUp) {
    stickToBottom = false;
  } else if (isNearBottom()) {
    stickToBottom = true;
  }
  lastMessageScrollTop = currentTop;
});

const lastMessage = messageList.querySelector('.message:last-of-type');
if (lastMessage) queueMarkChannelRead(parseInt(lastMessage.dataset.messageId, 10));
setUnreadDot(channelId, false);
scrollMessagesToBottom(true);
startEmojiSuggestWatcher();
autoResizeInput();
window.setTimeout(scrollToMessageFromHash, 80);

if (isMobileInputMode && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (document.activeElement === input) {
      keepBottomOnMobileFocus();
    }
  });
}
