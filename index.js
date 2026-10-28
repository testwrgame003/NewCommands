const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const { Redis } = require("@upstash/redis");

// ================= CONFIGURACIÓN =================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PANEL_CHANNEL_ID = "1564890852310913034";
const CHAMPION_ROLE_ID = "1486206362332434634";
const MAX_ONLINE_PER_GROUP = 25;

const GROUP_CONFIG = {
  Trainer: { label: "Trainer" },
  Gym_Leader: { label: "Gym Leader" },
  Elite_Four: { label: "Elite Four" },
  Rivals: { label: "Rivals" }
};

const RIVALS_SESSIONS_KEY = "rivals_sessions";
const RIVAL_ROTATION_MS = 60 * 60 * 1000; // 1 hour

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// ================= CLAVES DE REDIS =================

const onlineKey = (group) => `online:${group}`;
const usersKey = (group) => `users:${group}`;
const vipKey = (group) => `vip:${group}`;
const schedulesKey = () => "daily_schedules";
const panelDataKey = () => "panel_data";
const activeRolesKey = () => "active_roles";

// ================= PARSERS =================

function safeJsonParse(value, fallback = null) {
  let v = value;
  for (let i = 0; i < 4; i++) {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return v;
    if (typeof v !== "string") return fallback;
    const s = v
      .trim()
      .replace(/^\uFEFF/, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/,\s*$/, "");
    try {
      v = JSON.parse(s);
    } catch (err) {
      return fallback;
    }
  }
  return typeof v === "object" && v !== null ? v : fallback;
}

function cleanGameId(val) {
  if (val === null || val === undefined) return null;
  const digits = String(val).replace(/\D/g, "").trim();
  return /^\d{16}$/.test(digits) ? digits : null;
}

function isValidGameId(id) {
  return /^\d{16}$/.test(String(id || "").replace(/\s+/g, "").trim());
}

function uniqueList(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x || "").trim()).filter(Boolean))];
}

function normalizeUser(raw, fallbackName = "Unknown") {
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const name = String(parsed.name || parsed.displayName || fallbackName).trim() || "Unknown";
  const heartbeatName = String(parsed.heartbeatName || parsed.hb_name || name).trim() || name;
  const mainId = cleanGameId(parsed.main_id ?? parsed.mainId ?? parsed.id);
  const secId = cleanGameId(parsed.sec_id ?? parsed.secId);

  const aliases = uniqueList([
    ...(Array.isArray(parsed.aliases) ? parsed.aliases : []),
    name,
    heartbeatName
  ]);

  return { ...parsed, name, heartbeatName, aliases, main_id: mainId, sec_id: secId };
}

function buildUserData(oldRaw, interaction, updates = {}) {
  const discordName = interaction?.member?.displayName || interaction?.user?.username || "Unknown";
  const oldData = normalizeUser(oldRaw, discordName) || {};

  const finalMainId = updates.main_id !== undefined ? cleanGameId(updates.main_id) : cleanGameId(oldData.main_id);
  const finalSecId = updates.sec_id !== undefined ? cleanGameId(updates.sec_id) : cleanGameId(oldData.sec_id);
  const name = String(updates.name || oldData.name || discordName).trim();
  const heartbeatName = String(updates.heartbeatName || oldData.heartbeatName || name).trim();

  const aliases = uniqueList([
    ...(Array.isArray(oldData.aliases) ? oldData.aliases : []),
    ...(Array.isArray(updates.aliases) ? updates.aliases : []),
    oldData.name,
    oldData.heartbeatName,
    discordName,
    name,
    heartbeatName
  ]);

  return { ...oldData, ...updates, name, heartbeatName, aliases, main_id: finalMainId, sec_id: finalSecId, updatedAt: Date.now() };
}

// ================= OPERACIONES ATÓMICAS =================

async function getUser(discordId, group) {
  if (!GROUP_CONFIG[group]) return null;
  const raw = await redis.hget(usersKey(group), String(discordId).trim());
  return raw ? normalizeUser(raw) : null;
}

async function saveSingleUser(discordId, userObj, group) {
  if (!discordId || !GROUP_CONFIG[group] || !userObj) return false;
  const cleanId = String(discordId).trim();
  const existing = await getUser(cleanId, group);
  const merged = normalizeUser({ ...(existing || {}), ...userObj });
  if (!merged) return false;
  await redis.hset(usersKey(group), { [cleanId]: JSON.stringify(merged) });
  return true;
}

async function getUsers(group) {
  if (!GROUP_CONFIG[group]) return {};
  const data = await redis.hgetall(usersKey(group));
  if (!data || typeof data !== "object") return {};
  const users = {};
  for (const [uid, raw] of Object.entries(data)) {
    const user = normalizeUser(raw);
    if (user) users[String(uid).trim()] = user;
  }
  return users;
}

async function isGameIdAlreadyUsed(id, group, ignoreDiscordId = null) {
  const targetId = cleanGameId(id);
  if (!targetId || !GROUP_CONFIG[group]) return false;
  const users = await getUsers(group);
  for (const [uid, u] of Object.entries(users)) {
    if (ignoreDiscordId && String(uid) === String(ignoreDiscordId)) continue;
    if (u.main_id === targetId || u.sec_id === targetId) return true;
  }
  return false;
}

async function findUserRegistration(discordId, preferredGroup = null) {
  const allGroups = Object.keys(GROUP_CONFIG);
  const groups = preferredGroup && GROUP_CONFIG[preferredGroup] ? [preferredGroup, ...allGroups.filter((g) => g !== preferredGroup)] : allGroups;
  for (const group of groups) {
    const userData = await getUser(discordId, group);
    if (userData) return { group, userData };
  }
  return null;
}

// ================= ROLES =================

function isChampion(interaction) {
  return interaction.member?.roles?.cache?.has(CHAMPION_ROLE_ID) || interaction.member?.roles?.cache?.some((r) => r.name === "Champion");
}

function getGroupLabel(group) {
  return GROUP_CONFIG[group]?.label || group;
}

function normalizeSelectableRoleName(roleName) {
  const map = {
    Trainer: "Trainer", Gym_Leader: "Gym_Leader", "Gym Leader": "Gym_Leader",
    Elite_Four: "Elite_Four", "Elite Four": "Elite_Four",
    Rivals: "Rivals", "Rival Duo": "Rivals", "Rival_Duo": "Rivals"
  };
  return map[roleName] || null;
}

function getMemberSelectableRoles(member) {
  if (!member?.roles?.cache) return [];
  return member.roles.cache.map((role) => normalizeSelectableRoleName(role.name)).filter(Boolean).filter((g, i, arr) => arr.indexOf(g) === i);
}

async function getActiveRole(userId) {
  const direct = await redis.get(`active_roles:${userId}`);
  if (direct && typeof direct === "string") return direct;
  return null;
}

async function setActiveRole(userId, role) {
  await redis.set(`active_roles:${userId}`, role);
}

async function getUserGroup(interaction) {
  const memberGroups = getMemberSelectableRoles(interaction.member);
  if (!memberGroups.length) return null;
  const savedRole = await getActiveRole(interaction.user.id);
  if (savedRole && memberGroups.includes(savedRole)) return savedRole;
  const priority = ["Rivals", "Elite_Four", "Gym_Leader", "Trainer"];
  for (const role of priority) {
    if (memberGroups.includes(role)) return role;
  }
  return null;
}

// ================= ONLINE =================

async function getOnlineIDs(group) {
  if (!GROUP_CONFIG[group]) return [];
  const ids = await redis.smembers(onlineKey(group));
  return Array.isArray(ids) ? ids.map(cleanGameId).filter(Boolean) : [];
}

async function setOnlineStatus(action, id, group) {
  const clean = cleanGameId(id);
  if (!["online", "offline"].includes(action) || !clean || !GROUP_CONFIG[group]) return false;
  if (action === "online") await redis.sadd(onlineKey(group), clean);
  else await redis.srem(onlineKey(group), clean);
  return true;
}

async function addVipID(id, group) {
  const clean = cleanGameId(id);
  if (!clean || !GROUP_CONFIG[group]) return false;
  await redis.sadd(vipKey(group), clean);
  await redis.hset(`${vipKey(group)}:timestamps`, { [clean]: Math.floor(Date.now() / 1000) }).catch(() => {});
  return true;
}

async function getOnlineUsersByGroup(group) {
  if (!GROUP_CONFIG[group]) return [];
  const onlineIds = await getOnlineIDs(group);
  if (!onlineIds.length) return [];
  
  const users = await getUsers(group);
  const results = [];
  const activeRivalsIds = new Map();

  const sessionsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY);
  if (sessionsRaw) {
    for (const raw of Object.values(sessionsRaw)) {
      const s = safeJsonParse(raw);
      if (s && s.targetGroup === group && s.activeIndex !== -1) {
        const activeMember = s.members[s.activeIndex];
        if (activeMember) activeRivalsIds.set(activeMember.gameId, s);
      }
    }
  }

  for (const id of onlineIds) {
    if (activeRivalsIds.has(id)) continue;
    let foundUser = Object.values(users).find(u => u.main_id === id || u.sec_id === id);
    results.push({ id, label: foundUser ? foundUser.name : `Unknown (${id})` });
  }

  for (const [id, session] of activeRivalsIds.entries()) {
    const activeMember = session.members[session.activeIndex];
    results.push({ id, label: `🤝 Rivals Session (${activeMember.name} is active)` });
  }

  return results;
}

// ================= RIVALS MATCHMAKING & SYSTEM =================

async function getRivalsSessionById(sessionId) {
  const raw = await redis.hget(RIVALS_SESSIONS_KEY, sessionId);
  return safeJsonParse(raw);
}

async function getRivalsSessionByUser(discordId) {
  const sessionsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY);
  if (!sessionsRaw) return null;
  for (const raw of Object.values(sessionsRaw)) {
    const s = safeJsonParse(raw);
    if (s && s.members.some(m => m.discordId === String(discordId))) return s;
  }
  return null;
}

async function saveRivalsSession(session) {
  if (!session?.id) return false;
  await redis.hset(RIVALS_SESSIONS_KEY, { [session.id]: JSON.stringify(session) });
  return true;
}

async function activateRivalsSession(sessionId, forceRotation = false) {
  const session = await getRivalsSessionById(sessionId);
  if (!session) return;

  const now = Date.now();
  const timePassed = now - session.lastRotationAt >= RIVAL_ROTATION_MS;

  if (forceRotation || timePassed) {
    const currentActiveUser = session.members[session.activeIndex];
    if (currentActiveUser) {
      await redis.srem(onlineKey(session.targetGroup), currentActiveUser.gameId);
    }

    let nextIndex = (session.activeIndex + 1) % 2;
    const m0Yield = session.ceded[session.members[0]?.discordId];
    const m1Yield = session.members[1] && session.ceded[session.members[1].discordId];

    if (session.members.length === 2) {
      if (m0Yield && m1Yield) nextIndex = -1;
      else if (m0Yield) nextIndex = 1;
      else if (m1Yield) nextIndex = 0;
    }

    session.activeIndex = nextIndex;
    session.lastRotationAt = now;

    if (session.activeIndex !== -1) {
      const nextUser = session.members[session.activeIndex];
      if (nextUser) {
        await redis.sadd(onlineKey(session.targetGroup), nextUser.gameId);
      }
    }

    await saveRivalsSession(session);
  }
}

async function setRivalsOffline(discordId) {
  const session = await getRivalsSessionByUser(discordId);
  if (!session) return { ok: false, message: "❌ You are not in any active Rivals session." };

  const memberIndex = session.members.findIndex(m => m.discordId === String(discordId));
  if (memberIndex === -1) return { ok: false, message: "❌ Error finding your member data." };

  if (session.activeIndex === memberIndex) {
    await redis.srem(onlineKey(session.targetGroup), session.members[memberIndex].gameId);
  }

  session.members.splice(memberIndex, 1);

  if (session.members.length === 0) {
    await redis.hdel(RIVALS_SESSIONS_KEY, session.id);
    return { ok: true, message: "🔴 You went offline. Rivals session closed." };
  }

  if (session.activeIndex === memberIndex) {
    session.activeIndex = 0;
    session.lastRotationAt = Date.now();
    await redis.sadd(onlineKey(session.targetGroup), session.members[0].gameId);
  } else {
    session.activeIndex = 0;
  }

  session.ceded = {};
  await saveRivalsSession(session);

  try {
    const remaining = await client.users.fetch(session.members[0].discordId);
    await remaining.send("⚠️ Your partner went offline. You are now rerolling in **Solo Mode (1h ON, 1h OFF)**.");
  } catch (e) {}

  return { ok: true, message: "🔴 You went offline and left the Rivals session." };
}

async function toggleCedeReroll(discordId) {
  const session = await getRivalsSessionByUser(discordId);
  if (!session) return { ok: false, message: "❌ You are not in any active Rivals session." };
  if (session.members.length < 2) return { ok: false, message: "❌ You need a complete Duo to yield your reroll." };

  session.ceded = session.ceded || {};
  session.ceded[discordId] = !session.ceded[discordId];

  await saveRivalsSession(session);
  await activateRivalsSession(session.id, true);

  const msg = session.ceded[discordId]
    ? "⚠️ **You yielded your reroll**. Your ID will be skipped, keeping your partner active."
    : "✅ **You reclaimed your reroll**. Normal hourly rotation resumed.";
  return { ok: true, message: msg };
}

function formatRivalTime(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m`;
}

async function buildRivalsListMessage() {
  const sessionsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY);
  if (!sessionsRaw || Object.keys(sessionsRaw).length === 0) {
    return "📭 No active Rivals sessions.";
  }

  let msg = "🤝 **Rivals Sessions & Timers**\n\n";
  let index = 1;

  for (const raw of Object.values(sessionsRaw)) {
    const s = safeJsonParse(raw);
    if (!s) continue;

    const timeElapsed = Date.now() - s.lastRotationAt;
    const timeLeft = Math.max(0, RIVAL_ROTATION_MS - timeElapsed);
    const timeStr = formatRivalTime(timeLeft);

    msg += `**#${index} — Session [${getGroupLabel(s.targetGroup)}]**\n`;

    const m0 = s.members[0];
    const m1 = s.members[1];

    const m0Yield = s.ceded[m0?.discordId] ? " 🚫 *(Yielded)*" : "";
    const m1Yield = m1 && s.ceded[m1.discordId] ? " 🚫 *(Yielded)*" : "";

    msg += `User A: <@${m0.discordId}> | ID: \`${m0.gameId}\`${m0Yield}\n`;
    if (m1) {
      msg += `User B: <@${m1.discordId}> | ID: \`${m1.gameId}\`${m1Yield}\n`;
    } else {
      msg += `User B: ⏳ *Waiting for partner...*\n`;
    }

    if (s.activeIndex === -1) {
      msg += `Status: ⏸️ Paused (Both yielded)\n`;
    } else if (s.activeIndex === 0) {
      msg += `Status: 🟢 **${m0.name}** is active (${timeStr} left)\n`;
    } else if (s.activeIndex === 1) {
      if (m1) {
        msg += `Status: 🟢 **${m1.name}** is active (${timeStr} left)\n`;
      } else {
        msg += `Status: 💤 **Resting Hour** (Solo mode, ${timeStr} left)\n`;
      }
    }
    msg += "\n";
    index++;
  }
  return msg.slice(0, 1950);
}

// ================= SCHEDULER DIARIO =================

async function loadSchedules() {
  const data = await redis.get(schedulesKey());
  return safeJsonParse(data, {});
}

async function saveSchedules(data) {
  await redis.set(schedulesKey(), JSON.stringify(data || {}));
}

function startDailyScheduler() {
  setInterval(async () => {
    const schedules = await loadSchedules();
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const todayUTC = now.toISOString().slice(0, 10);
    let changed = false;

    for (const userId in schedules) {
      const s = schedules[userId];
      if (!s?.group || !s?.main_id) continue;
      if (s.online_hour === utcHour && s.online_minute === utcMinute && s.last_online !== todayUTC) {
        const ok = await setOnlineStatus("online", s.main_id, s.group);
        if (ok) { s.last_online = todayUTC; changed = true; }
      }
      if (s.offline_hour === utcHour && s.offline_minute === utcMinute && s.last_offline !== todayUTC) {
        const ok = await setOnlineStatus("offline", s.main_id, s.group);
        if (ok) { s.last_offline = todayUTC; changed = true; }
      }
    }
    if (changed) await saveSchedules(schedules);
  }, 60 * 1000);
}

// ================= PANEL DE CONTROL VISUAL =================

async function loadPanelData() {
  const data = await redis.get(panelDataKey());
  return safeJsonParse(data, {});
}

async function savePanelData(data) {
  await redis.set(panelDataKey(), JSON.stringify(data || {}));
}

async function sendPanel(channel) {
  if (!channel) return;
  const panelData = await loadPanelData();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("⚡ ZENITH REROLL — CONTROL CENTER")
    .setDescription("Select an option from the dropdown below to learn how each button and the new Rivals system works.")
    .setFooter({ text: "All interactions are private (Ephemeral)" });

  // NUEVO: Menú desplegable de ayuda
  const helpRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("panel_help_menu")
      .setPlaceholder("📖 Information & Guides (Select one)")
      .addOptions([
        { label: "🔘 Buttons Guide", description: "Learn what each control button does", value: "help_buttons" },
        { label: "🤝 New Rivals System", description: "How matchmaking and solo-mode work", value: "help_rivals" }
      ])
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("offline").setLabel("Offline").setEmoji("🔴").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("online_sec").setLabel("Online Sec").setEmoji("⚡").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("online_list").setLabel("Online List").setEmoji("📡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("list").setLabel("Registered List").setEmoji("📋").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("register").setLabel("Register Main").setEmoji("🆔").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("add_sec").setLabel("Add Secondary").setEmoji("➕").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change").setLabel("Change ID").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("heartbeat_name").setLabel("Heartbeat Name").setEmoji("🏷️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change_role").setLabel("Switch Group").setEmoji("🎭").setStyle(ButtonStyle.Primary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rivals_list").setLabel("Rivals Status & Timers").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cede_reroll").setLabel("Yield Reroll").setEmoji("⏭️").setStyle(ButtonStyle.Danger)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("schedule").setLabel("Auto Schedule (UTC)").setEmoji("⏰").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("gp").setLabel("Add VIP ID").setEmoji("👑").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("set_offline").setLabel("Force Offline").setEmoji("🛡️").setStyle(ButtonStyle.Danger)
  );

  // Agregamos helpRow al principio
  const panelPayload = { embeds: [embed], components: [helpRow, row1, row2, row3, row4] };

  try {
    if (panelData.messageId) {
      const msg = await channel.messages.fetch(panelData.messageId);
      await msg.edit(panelPayload);
      return;
    }
  } catch {}
  const newMsg = await channel.send(panelPayload);
  panelData.messageId = newMsg.id;
  await savePanelData(panelData);
}

// ================= COMANDOS =================

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName("register").setDescription("Register your main game ID").addStringOption((o) => o.setName("id").setDescription("16 digit main ID").setRequired(true)),
    new SlashCommandBuilder().setName("change").setDescription("Change your main game ID").addStringOption((o) => o.setName("id").setDescription("New 16 digit ID").setRequired(true)),
    new SlashCommandBuilder().setName("add_sec").setDescription("Register your secondary game ID").addStringOption((o) => o.setName("id").setDescription("16 digit secondary ID").setRequired(true)),
    new SlashCommandBuilder().setName("heartbeat_name").setDescription("Set your exact heartbeat name").addStringOption((o) => o.setName("name").setDescription("Exact name shown in your heartbeat").setRequired(true)),
    new SlashCommandBuilder().setName("rivals_list").setDescription("Show all Rivals sessions and active rotation status"),
    new SlashCommandBuilder().setName("yield_reroll").setDescription("Yield your active reroll slot in Rivals"),
    new SlashCommandBuilder().setName("change_rol").setDescription("Select your active reroll group"),
    new SlashCommandBuilder().setName("online").setDescription("Set your main account online"),
    new SlashCommandBuilder().setName("online_sec").setDescription("Set your secondary account online"),
    new SlashCommandBuilder().setName("offline").setDescription("Set your accounts offline"),
    new SlashCommandBuilder().setName("list").setDescription("List registered users in your group"),
    new SlashCommandBuilder().setName("online_list").setDescription("List online users in your group"),
    new SlashCommandBuilder().setName("online_count").setDescription("Shows how many users are online in each group"),
    new SlashCommandBuilder().setName("schedule_events").setDescription("Daily online/offline scheduler (UTC)")
      .addStringOption((o) => o.setName("mode").setDescription("Start or Stop").setRequired(true).addChoices({ name: "Start Daily Schedule", value: "start" }, { name: "Stop All Schedules", value: "stop" }))
      .addIntegerOption((o) => o.setName("online_hour").setDescription("Online Hour (UTC 0-23)"))
      .addIntegerOption((o) => o.setName("online_minute").setDescription("Online Minute (0-59)"))
      .addIntegerOption((o) => o.setName("offline_hour").setDescription("Offline Hour (UTC 0-23)"))
      .addIntegerOption((o) => o.setName("offline_minute").setDescription("Offline Minute (0-59)")),
    new SlashCommandBuilder().setName("set_offline").setDescription("Force a user offline (Champion only)"),
    new SlashCommandBuilder().setName("add_vip").setDescription("Add VIP ID (Champion only)").addStringOption((o) => o.setName("id").setDescription("16 digit VIP ID").setRequired(true))
  ].map((cmd) => cmd.toJSON());

  if (!CLIENT_ID || !GUILD_ID) return;
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ================= LÓGICA DE USUARIOS COMÚN =================

async function handleRegisterMain(interaction, rawId) {
  const group = await getUserGroup(interaction);
  if (!group || !GROUP_CONFIG[group]) return "❌ You must have a valid group role (**Trainer**, **Gym Leader**, **Elite Four**, or **Rivals**).";
  const id = cleanGameId(rawId);
  if (!id) return "❌ ID must be exactly 16 digits.";
  if (await isGameIdAlreadyUsed(id, group, interaction.user.id)) return `❌ ID \`${id}\` is already registered by another user in **${getGroupLabel(group)}**.`;

  const oldData = await getUser(interaction.user.id, group);
  const newUserData = buildUserData(oldData, interaction, { main_id: id, sec_id: oldData?.sec_id || null });
  const saved = await saveSingleUser(interaction.user.id, newUserData, group);
  if (!saved) return "❌ Error saving your registration in Redis.";

  return `✅ **Main ID registered in ${getGroupLabel(group)}**\n🆔 Main ID: \`${newUserData.main_id}\`\n👤 Display Name: **${newUserData.name}**\n📡 Heartbeat Name: **${newUserData.heartbeatName}**`;
}

async function handleAddSecondary(interaction, rawSecId) {
  const group = await getUserGroup(interaction);
  if (!group || !GROUP_CONFIG[group]) return "❌ No valid group detected.";
  const secId = cleanGameId(rawSecId);
  if (!secId) return "❌ Secondary ID must be exactly 16 digits.";
  if (await isGameIdAlreadyUsed(secId, group, interaction.user.id)) return `❌ ID \`${secId}\` is already registered by another user in **${getGroupLabel(group)}**.`;

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) return "❌ You must register your Main ID first.";
  const newUserData = buildUserData(oldData, interaction, { sec_id: secId });
  await saveSingleUser(interaction.user.id, newUserData, group);
  return `✅ Secondary ID \`${secId}\` added in **${getGroupLabel(group)}**.`;
}

async function handleChangeMainId(interaction, rawNewId) {
  const newId = cleanGameId(rawNewId);
  if (!newId) return "❌ ID must be exactly 16 digits.";
  const group = await getUserGroup(interaction);
  if (!group) return "❌ No active group detected.";

  if (await isGameIdAlreadyUsed(newId, group, interaction.user.id)) return `❌ ID \`${newId}\` is already being used by another user in **${getGroupLabel(group)}**.`;

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) return "❌ You must register first before changing your ID.";

  if (group === "Rivals") {
    const session = await getRivalsSessionByUser(interaction.user.id);
    if (session) {
      const mIdx = session.members.findIndex(m => m.discordId === interaction.user.id);
      if (mIdx !== -1) {
        const oldId = session.members[mIdx].gameId;
        session.members[mIdx].gameId = newId;
        if (session.activeIndex === mIdx) {
          await redis.srem(onlineKey(session.targetGroup), oldId);
          await redis.sadd(onlineKey(session.targetGroup), newId);
        }
        await saveRivalsSession(session);
      }
    }
  }

  if (oldData.main_id && oldData.main_id !== newId) await setOnlineStatus("offline", oldData.main_id, group);
  const updated = buildUserData(oldData, interaction, { main_id: newId, sec_id: oldData.sec_id || null });
  await saveSingleUser(interaction.user.id, updated, group);

  return `🔄 **Main ID updated in ${getGroupLabel(group)}**\n🆔 New ID: \`${updated.main_id}\`\n👤 Display Name: **${updated.name}**\n📡 Heartbeat Name: **${updated.heartbeatName}**`;
}

async function handleUpdateHeartbeatName(interaction, rawHbName) {
  const hbName = String(rawHbName || "").trim();
  if (!hbName) return "❌ Invalid heartbeat name.";
  const group = await getUserGroup(interaction);
  if (!group) return "❌ No group detected.";

  if (group === "Rivals") {
    const session = await getRivalsSessionByUser(interaction.user.id);
    if (session) {
      const mIdx = session.members.findIndex(m => m.discordId === interaction.user.id);
      if (mIdx !== -1) {
        session.members[mIdx].heartbeatName = hbName;
        await saveRivalsSession(session);
      }
    }
  }

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) return "❌ You must register your Main ID first.";
  const updated = buildUserData(oldData, interaction, { heartbeatName: hbName });
  await saveSingleUser(interaction.user.id, updated, group);

  return `✅ **Heartbeat Name updated in ${getGroupLabel(group)}**\n👤 Display Name: **${updated.name}**\n📡 Heartbeat Name: **${updated.heartbeatName}**`;
}

// ================= EVENTOS =================

client.once("clientReady", async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  await registerSlashCommands();
  
  try {
    const ch = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
    if (ch) await sendPanel(ch);
  } catch (err) {}

  startDailyScheduler();

  setInterval(async () => {
    try {
      const sessionsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY);
      if (sessionsRaw) {
        for (const raw of Object.values(sessionsRaw)) {
          const s = safeJsonParse(raw);
          if (s) await activateRivalsSession(s.id, false);
        }
      }
    } catch (err) {}
  }, 60 * 1000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // ---------------------------------------------------------
    // 1. SLASH COMMANDS
    // ---------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "register") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleRegisterMain(interaction, interaction.options.getString("id")));
      }
      if (commandName === "change") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleChangeMainId(interaction, interaction.options.getString("id")));
      }
      if (commandName === "add_sec") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleAddSecondary(interaction, interaction.options.getString("id")));
      }
      if (commandName === "heartbeat_name") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleUpdateHeartbeatName(interaction, interaction.options.getString("name")));
      }
      if (commandName === "yield_reroll") {
        await interaction.deferReply({ ephemeral: true });
        const res = await toggleCedeReroll(interaction.user.id);
        return interaction.editReply(res.message);
      }
      if (commandName === "rivals_list") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await buildRivalsListMessage());
      }
      if (commandName === "online_count") {
        await interaction.deferReply({ ephemeral: true });
        const lines = [];
        for (const group of Object.keys(GROUP_CONFIG)) {
          const count = (await getOnlineUsersByGroup(group)).length;
          lines.push(`• **${getGroupLabel(group)}**: \`${count}/${MAX_ONLINE_PER_GROUP}\` online`);
        }
        return interaction.editReply(`## 🟢 Online Users\n\n${lines.join("\n")}`);
      }
      if (commandName === "online") {
        await interaction.deferReply({ ephemeral: true });
        const activeRole = await getUserGroup(interaction);
        if (activeRole === "Rivals") {
          const session = await getRivalsSessionByUser(interaction.user.id);
          if (session) return interaction.editReply("❌ You are already in an active Rivals session.");
          const userData = await getUser(interaction.user.id, "Rivals");
          if (!userData?.main_id) return interaction.editReply("❌ Register your Main ID first.");
          
          const menu = new StringSelectMenuBuilder().setCustomId("rivals_target_group").setPlaceholder("Select target group").addOptions([
            { label: "Elite Four", value: "Elite_Four" }, { label: "Gym Leader", value: "Gym_Leader" }
          ]);
          return interaction.editReply({ content: "🎯 Choose the target group where you want to reroll:", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) return interaction.editReply("❌ Register your Main ID first.");
        const { userData, group } = found;
        if ((await getOnlineIDs(group)).length >= MAX_ONLINE_PER_GROUP) return interaction.editReply(`❌ The **${getGroupLabel(group)}** group is full.`);
        const ok = await setOnlineStatus("online", userData.main_id, group);
        return interaction.editReply(ok ? `🟢 Main account is now **ONLINE** in **${getGroupLabel(group)}**.` : "❌ Could not set main account online.");
      }
      if (commandName === "offline") {
        await interaction.deferReply({ ephemeral: true });
        const activeRole = await getUserGroup(interaction);
        if (activeRole === "Rivals") return interaction.editReply((await setRivalsOffline(interaction.user.id)).message);
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found) return interaction.editReply("❌ You are not registered.");
        if (found.userData.main_id) await setOnlineStatus("offline", found.userData.main_id, found.group);
        if (found.userData.sec_id) await setOnlineStatus("offline", found.userData.sec_id, found.group);
        return interaction.editReply(`🔴 **${found.userData.name}** is now **OFFLINE** in **${getGroupLabel(found.group)}**.`);
      }
      if (commandName === "online_sec") {
        await interaction.deferReply({ ephemeral: true });
        const activeRole = await getUserGroup(interaction);
        if (activeRole === "Rivals") return interaction.editReply("❌ Rivals Mode does not use secondary IDs.");
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.sec_id) return interaction.editReply("❌ No secondary ID registered.");
        const ok = await setOnlineStatus("online", found.userData.sec_id, found.group);
        return interaction.editReply(ok ? `🟢 Secondary account is now **ONLINE** in **${getGroupLabel(found.group)}**.` : "❌ Could not set secondary online.");
      }
      if (commandName === "list") {
        await interaction.deferReply({ ephemeral: true });
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ Select an active group first.");
        const users = await getUsers(group);
        if (!Object.keys(users).length) return interaction.editReply("📭 No users registered.");
        let msg = `📋 **Registered users in ${getGroupLabel(group)}:**\n\n`;
        for (const u of Object.values(users)) msg += `👤 **${u.name}** | 📡 \`${u.heartbeatName}\` → \`${u.main_id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }
      if (commandName === "online_list") {
        await interaction.deferReply({ ephemeral: true });
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No active role selected.");
        if (group === "Rivals") return interaction.editReply(await buildRivalsListMessage());
        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);
        let msg = `🟢 **Online in ${getGroupLabel(group)}:**\n\n`;
        for (const u of onlineUsers) msg += `• ${u.label} — \`${u.id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }
      if (commandName === "change_rol") {
        const userGroups = getMemberSelectableRoles(interaction.member);
        if (userGroups.length < 2) return interaction.reply({ content: "⚠️ You need at least 2 group roles to switch.", ephemeral: true });
        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder().setCustomId("role_select").setPlaceholder("Select your active group").addOptions(userGroups.map((g) => ({ label: getGroupLabel(g), value: g })));
        return interaction.reply({ content: `🎭 Current active role: **${getGroupLabel(currentRole)}**\nSelect your new active group:`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }
    }

    // ---------------------------------------------------------
    // 2. BOTONES DEL PANEL
    // ---------------------------------------------------------
    if (interaction.isButton()) {
      const { customId } = interaction;

      if (customId === "register") {
        const modal = new ModalBuilder().setCustomId("reg_modal").setTitle("Register Main Game ID");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("16-Digit Main ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (customId === "add_sec") {
        const modal = new ModalBuilder().setCustomId("sec_modal").setTitle("Add Secondary Game ID");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("16-Digit Secondary ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (customId === "change") {
        const modal = new ModalBuilder().setCustomId("change_modal").setTitle("Change Game ID");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("New 16-Digit ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (customId === "heartbeat_name") {
        const modal = new ModalBuilder().setCustomId("heartbeat_modal").setTitle("Set Heartbeat Name");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Exact name shown in your heartbeat").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }

      await interaction.deferReply({ ephemeral: true });

      if (customId === "online") {
        const activeRole = await getUserGroup(interaction);
        if (activeRole === "Rivals") {
          const session = await getRivalsSessionByUser(interaction.user.id);
          if (session) return interaction.editReply("❌ You are already in an active Rivals session.");
          const userData = await getUser(interaction.user.id, "Rivals");
          if (!userData?.main_id) return interaction.editReply("❌ Register your Main ID first.");
          
          const menu = new StringSelectMenuBuilder().setCustomId("rivals_target_group").setPlaceholder("Select target group").addOptions([
            { label: "Elite Four", value: "Elite_Four" }, { label: "Gym Leader", value: "Gym_Leader" }
          ]);
          return interaction.editReply({ content: "🎯 Choose the target group where you want to reroll:", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) return interaction.editReply("❌ Register your Main ID first.");
        const { group, userData } = found;
        if ((await getOnlineIDs(group)).length >= MAX_ONLINE_PER_GROUP) return interaction.editReply(`❌ The **${getGroupLabel(group)}** group is full.`);
        const ok = await setOnlineStatus("online", userData.main_id, group);
        return interaction.editReply(ok ? `🟢 Main account is **ONLINE** in **${getGroupLabel(group)}**.` : "❌ Could not set online.");
      }

      if (customId === "offline") {
        const activeGroup = await getUserGroup(interaction);
        if (activeGroup === "Rivals") return interaction.editReply((await setRivalsOffline(interaction.user.id)).message);
        const found = await findUserRegistration(interaction.user.id, activeGroup);
        if (!found) return interaction.editReply("❌ You are not registered.");
        if (found.userData.main_id) await setOnlineStatus("offline", found.userData.main_id, found.group);
        if (found.userData.sec_id) await setOnlineStatus("offline", found.userData.sec_id, found.group);
        return interaction.editReply(`🔴 Set **OFFLINE** in **${getGroupLabel(found.group)}**.`);
      }

      if (customId === "online_sec") {
        const activeGroup = await getUserGroup(interaction);
        if (activeGroup === "Rivals") return interaction.editReply("❌ Rivals Mode does not use secondary IDs.");
        const found = await findUserRegistration(interaction.user.id, activeGroup);
        if (!found?.userData?.sec_id) return interaction.editReply("❌ No secondary ID registered.");
        const ok = await setOnlineStatus("online", found.userData.sec_id, found.group);
        return interaction.editReply(ok ? `🟢 Secondary account is **ONLINE** in **${getGroupLabel(found.group)}**.` : "❌ Could not set secondary online.");
      }

      if (customId === "list") {
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ Select an active group first.");
        const users = await getUsers(group);
        if (!Object.keys(users).length) return interaction.editReply("📭 No users registered.");
        let msg = `📋 **Users in ${getGroupLabel(group)}:**\n\n`;
        for (const u of Object.values(users)) msg += `👤 **${u.name}** | 📡 \`${u.heartbeatName}\` → \`${u.main_id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (customId === "online_list") {
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No active role selected.");
        if (group === "Rivals") return interaction.editReply(await buildRivalsListMessage());
        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);
        let msg = `🟢 **Online in ${getGroupLabel(group)}:**\n\n`;
        for (const u of onlineUsers) msg += `• ${u.label} — \`${u.id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (customId === "change_role") {
        const memberGroups = getMemberSelectableRoles(interaction.member);
        if (memberGroups.length < 2) return interaction.editReply("❌ You need at least 2 group roles to switch.");
        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder().setCustomId("role_select").setPlaceholder("Select your active role").addOptions(memberGroups.map((g) => ({ label: getGroupLabel(g), value: g })));
        return interaction.editReply({ content: `🎭 Current active role: **${getGroupLabel(currentRole)}**\nSelect your new active role:`, components: [new ActionRowBuilder().addComponents(menu)] });
      }

      if (customId === "cede_reroll") {
        const activeGroup = await getUserGroup(interaction);
        if (activeGroup !== "Rivals") return interaction.editReply("❌ You need the **Rivals** role active to use this.");
        return interaction.editReply((await toggleCedeReroll(interaction.user.id)).message);
      }
      
      if (customId === "rivals_list") {
        return interaction.editReply(await buildRivalsListMessage());
      }
    }

    // ---------------------------------------------------------
    // 3. SELECT MENUS
    // ---------------------------------------------------------
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;

      if (customId === "panel_help_menu") {
        const val = interaction.values[0];
        
        if (val === "help_buttons") {
          return interaction.reply({
            content: "🔘 **BUTTON GUIDE**\n\n" +
                     "**🟢 Online / 🔴 Offline:** Changes your active reroll status.\n" +
                     "**⚡ Online Sec:** Puts your secondary ID online (Not available for Rivals).\n" +
                     "**🆔 Register Main:** Links your 16-digit game ID to your Discord account.\n" +
                     "**🔄 Change ID:** Updates your game ID if you reinstall or change accounts.\n" +
                     "**🏷️ Heartbeat Name:** Sets the exact name your bot sends to the logs.\n" +
                     "**🎭 Switch Group:** Changes your active role if you have multiple reroll roles.\n" +
                     "**⏭️ Yield Reroll:** Skips your turn in a Rivals rotation, keeping your partner active continuously.",
            ephemeral: true
          });
        }
        
        if (val === "help_rivals") {
          return interaction.reply({
            content: "🤝 **HOW THE NEW RIVALS SYSTEM WORKS**\n\n" +
                     "1️⃣ **No Pre-Registration Needed:** You no longer need to register a duo beforehand. Just press **🟢 Online**.\n" +
                     "2️⃣ **Live Matchmaking:** When going online, you can choose to join an open session (someone waiting for a partner) or start a new one.\n" +
                     "3️⃣ **Solo Mode:** If you start a new session and nobody joins, you will reroll in Solo Mode (1 hour ON, 1 hour OFF) automatically while waiting.\n" +
                     "4️⃣ **Drop-in / Drop-out:** If your partner goes offline, your session doesn't die. You seamlessly return to Solo Mode without losing your spot.",
            ephemeral: true
          });
        }
      }

      if (customId === "role_select") {
        const selected = interaction.values[0];
        await setActiveRole(interaction.user.id, selected);
        return interaction.update({ content: `✅ Active role set to **${getGroupLabel(selected)}**.`, components: [] });
      }

      if (customId === "rivals_target_group") {
        const targetGroup = interaction.values[0];
        const sessionsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY);
        const openSessions = [];

        if (sessionsRaw) {
          for (const raw of Object.values(sessionsRaw)) {
            const s = safeJsonParse(raw);
            if (s && s.targetGroup === targetGroup && s.members.length === 1) {
              openSessions.push(s);
            }
          }
        }

        const options = [{ label: "🆕 Start new session (Solo Mode)", value: `new_${targetGroup}` }];
        openSessions.slice(0, 24).forEach(s => {
          options.push({ label: `🤝 Join ${s.members[0].name}'s Duo`, value: `join_${s.id}` });
        });

        const menu = new StringSelectMenuBuilder().setCustomId("rivals_matchmaking").setPlaceholder("Select an option").addOptions(options);
        return interaction.update({ content: `🔍 **Matchmaking for ${getGroupLabel(targetGroup)}**\nChoose an open session or start a new one:`, components: [new ActionRowBuilder().addComponents(menu)] });
      }

      if (customId === "rivals_matchmaking") {
        const val = interaction.values[0];
        const userData = await getUser(interaction.user.id, "Rivals");

        if (val.startsWith("new_")) {
          const targetGroup = val.replace("new_", "");
          const newSession = {
            id: `riv_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            targetGroup,
            members: [{ discordId: interaction.user.id, name: userData.name, gameId: userData.main_id, joinedAt: Date.now() }],
            activeIndex: 0,
            lastRotationAt: Date.now(),
            ceded: {}
          };
          await saveRivalsSession(newSession);
          await redis.sadd(onlineKey(targetGroup), userData.main_id);
          return interaction.update({ content: `✅ **Session created in ${getGroupLabel(targetGroup)}**.\nYou are now rerolling in Solo Mode (1h ON, 1h OFF). Anyone can join you.`, components: [] });
        }

        if (val.startsWith("join_")) {
          const sessionId = val.replace("join_", "");
          const session = await getRivalsSessionById(sessionId);
          if (!session || session.members.length >= 2) return interaction.update({ content: "❌ This session is no longer available.", components: [] });

          session.members.push({ discordId: interaction.user.id, name: userData.name, gameId: userData.main_id, joinedAt: Date.now() });

          if (session.activeIndex === 1) {
            session.lastRotationAt = Date.now();
            await redis.sadd(onlineKey(session.targetGroup), userData.main_id);
          }

          await saveRivalsSession(session);
          try {
            const partner = await client.users.fetch(session.members[0].discordId);
            await partner.send(`🤝 **Rivals Match!** <@${interaction.user.id}> has joined your Duo session in **${getGroupLabel(session.targetGroup)}**.`);
          } catch (e) {}

          const statusText = session.activeIndex === 1 ? "You are ACTIVE immediately!" : "Your partner is currently active. You will rotate in when their hour ends.";
          return interaction.update({ content: `✅ **Successfully joined ${session.members[0].name}'s Duo.**\n${statusText}`, components: [] });
        }
      }
    }
    
    // ---------------------------------------------------------
    // 4. MODALS
    // ---------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;
      if (customId === "reg_modal") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleRegisterMain(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "sec_modal") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleAddSecondary(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "change_modal") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleChangeMainId(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "heartbeat_modal") {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(await handleUpdateHeartbeatName(interaction, interaction.fields.getTextInputValue("name")));
      }
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Internal error.", ephemeral: true }).catch(() => {});
    else await interaction.editReply({ content: "❌ Internal error." }).catch(() => {});
  }
});

// ================= VIP DETECTION =================
client.on("messageCreate", async (message) => {
  if (message.author.bot && !message.webhookId) return;
  const group = Object.keys(GROUP_CONFIG).find(g => g === "Elite_Four" || g === "Gym_Leader" || g === "Trainer"); // Simplification for mapped channels if required
  // Ensure the actual CHANNEL_GROUP_MAP is used here in production if logic requires channel matching.
});

client.on("error", (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(TOKEN);
