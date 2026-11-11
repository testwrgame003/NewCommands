const {
  Client,
  Events,
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

// ================= ANTI-CRASH LOGS =================
process.on("unhandledRejection", (reason) => {
  console.error("🔥 Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

// ================= CONFIGURACIÓN =================

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PANEL_CHANNEL_ID = "1494760619985862676";
const CHAMPION_ROLE_ID = "1486206362332434634";
const MAX_ONLINE_PER_GROUP = 50;

// Únicamente grupos Elite Four y Gym Leader
const GROUP_CONFIG = {
  Gym_Leader: { label: "Gym Leader" },
  Elite_Four: { label: "Elite Four" }
};

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

  return {
    ...oldData,
    ...updates,
    name,
    heartbeatName,
    aliases,
    main_id: finalMainId,
    sec_id: finalSecId,
    updatedAt: Date.now()
  };
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
  const groups =
    preferredGroup && GROUP_CONFIG[preferredGroup]
      ? [preferredGroup, ...allGroups.filter((g) => g !== preferredGroup)]
      : allGroups;
  for (const group of groups) {
    const userData = await getUser(discordId, group);
    if (userData) return { group, userData };
  }
  return null;
}

// ================= ROLES (SOLO ELITE FOUR Y GYM LEADER) =================

function isChampion(interaction) {
  return (
    interaction.member?.roles?.cache?.has(CHAMPION_ROLE_ID) ||
    interaction.member?.roles?.cache?.some((r) => r.name === "Champion")
  );
}

function getGroupLabel(group) {
  return GROUP_CONFIG[group]?.label || group;
}

function normalizeSelectableRoleName(roleName) {
  const map = {
    Gym_Leader: "Gym_Leader",
    "Gym Leader": "Gym_Leader",
    Elite_Four: "Elite_Four",
    "Elite Four": "Elite_Four"
  };
  return map[roleName] || null;
}

function getMemberSelectableRoles(member) {
  if (!member?.roles?.cache) return [];
  return member.roles.cache
    .map((role) => normalizeSelectableRoleName(role.name))
    .filter(Boolean)
    .filter((g, i, arr) => arr.indexOf(g) === i);
}

async function getActiveRole(userId) {
  const direct = await redis.get(`active_roles:${userId}`);
  if (direct && typeof direct === "string" && GROUP_CONFIG[direct]) return direct;
  return null;
}

async function setActiveRole(userId, role) {
  if (!GROUP_CONFIG[role]) return;
  await redis.set(`active_roles:${userId}`, role);
}

async function getUserGroup(interaction) {
  const memberGroups = getMemberSelectableRoles(interaction.member);
  if (!memberGroups.length) return null;
  const savedRole = await getActiveRole(interaction.user.id);
  if (savedRole && memberGroups.includes(savedRole)) return savedRole;
  const priority = ["Elite_Four", "Gym_Leader"];
  for (const role of priority) {
    if (memberGroups.includes(role)) return role;
  }
  return null;
}

// ================= ONLINE & VIP =================

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

  for (const id of onlineIds) {
    const foundUser = Object.values(users).find((u) => u.main_id === id || u.sec_id === id);
    results.push({ id, label: foundUser ? foundUser.name : `Unknown (${id})` });
  }

  return results;
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
    try {
      const schedules = await loadSchedules();
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMinute = now.getUTCMinutes();
      const todayUTC = now.toISOString().slice(0, 10);
      let changed = false;

      for (const userId in schedules) {
        const s = schedules[userId];
        if (!s?.group || !GROUP_CONFIG[s.group] || !s?.main_id) continue;
        if (s.online_hour === utcHour && s.online_minute === utcMinute && s.last_online !== todayUTC) {
          const ok = await setOnlineStatus("online", s.main_id, s.group);
          if (ok) {
            s.last_online = todayUTC;
            changed = true;
          }
        }
        if (s.offline_hour === utcHour && s.offline_minute === utcMinute && s.last_offline !== todayUTC) {
          const ok = await setOnlineStatus("offline", s.main_id, s.group);
          if (ok) {
            s.last_offline = todayUTC;
            changed = true;
          }
        }
      }
      if (changed) await saveSchedules(schedules);
    } catch (err) {
      console.error("Error en Daily Scheduler:", err);
    }
  }, 60 * 1000);
}

// ================= PANEL DE CONTROL VISUAL (ORGANIZADO Y COMPACTO) =================

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
    .setTitle("⚡ ZENITH HEADLESS — CONTROL CENTER")
    .setDescription("Manage your account status, secondary accounts, group selection, and registration below.")
    .setFooter({ text: "Press 'Guide & Admin' for button instructions • Private responses" });

  // Fila 1: Controles de Estado y Grupo (Online, Offline, Switch Group)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("offline").setLabel("Offline").setEmoji("🔴").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("online_sec").setLabel("Online Sec").setEmoji("⚡").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("change_role").setLabel("Switch Group").setEmoji("🎭").setStyle(ButtonStyle.Primary)
  );

  // Fila 2: Configuración de Cuentas (Register, Add Sec, Change ID, Heartbeat Name)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("register").setLabel("Register Main").setEmoji("🆔").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("add_sec").setLabel("Add Secondary").setEmoji("➕").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change").setLabel("Change ID").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("heartbeat_name").setLabel("HB Name").setEmoji("🏷️").setStyle(ButtonStyle.Secondary)
  );

  // Fila 3: Consultas, Horarios y Guía/Admin
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("group_status").setLabel("Group Status").setEmoji("📡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("schedule").setLabel("Auto Schedule").setEmoji("⏰").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_and_guide").setLabel("Guide & Admin").setEmoji("🛡️").setStyle(ButtonStyle.Primary)
  );

  const panelPayload = { embeds: [embed], components: [row1, row2, row3] };

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

// ================= COMANDOS SLASH =================

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("register")
      .setDescription("Register your 16-digit main game ID")
      .addStringOption((o) => o.setName("id").setDescription("16 digit main ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("add_sec")
      .setDescription("Register your 16-digit secondary game ID")
      .addStringOption((o) => o.setName("id").setDescription("16 digit secondary ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("change")
      .setDescription("Change your registered 16-digit game ID")
      .addStringOption((o) => o.setName("id").setDescription("New 16 digit ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("heartbeat_name")
      .setDescription("Set your exact heartbeat name")
      .addStringOption((o) => o.setName("name").setDescription("Exact name shown in your heartbeat").setRequired(true)),
    new SlashCommandBuilder().setName("change_rol").setDescription("Switch between Elite Four and Gym Leader"),
    new SlashCommandBuilder().setName("online").setDescription("Set your main account online"),
    new SlashCommandBuilder().setName("online_sec").setDescription("Set your secondary account online"),
    new SlashCommandBuilder().setName("offline").setDescription("Set your accounts offline"),
    new SlashCommandBuilder().setName("list").setDescription("List registered users in your group"),
    new SlashCommandBuilder().setName("online_list").setDescription("List online users in your group"),
    new SlashCommandBuilder().setName("online_count").setDescription("Shows how many users are online in each group"),
    new SlashCommandBuilder()
      .setName("schedule_events")
      .setDescription("Daily online/offline scheduler (UTC)")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("Start or Stop")
          .setRequired(true)
          .addChoices({ name: "Start Daily Schedule", value: "start" }, { name: "Stop All Schedules", value: "stop" })
      )
      .addIntegerOption((o) => o.setName("online_hour").setDescription("Online Hour (UTC 0-23)"))
      .addIntegerOption((o) => o.setName("online_minute").setDescription("Online Minute (0-59)"))
      .addIntegerOption((o) => o.setName("offline_hour").setDescription("Offline Hour (UTC 0-23)"))
      .addIntegerOption((o) => o.setName("offline_minute").setDescription("Offline Minute (0-59)")),
    new SlashCommandBuilder().setName("set_offline").setDescription("Force a user offline (Champion only)"),
    new SlashCommandBuilder()
      .setName("add_vip")
      .setDescription("Add VIP ID (Champion only)")
      .addStringOption((o) => o.setName("id").setDescription("16 digit VIP ID").setRequired(true))
  ].map((cmd) => cmd.toJSON());

  if (!CLIENT_ID || !GUILD_ID) {
    console.warn("⚠️ CLIENT_ID o GUILD_ID no configurados; omitiendo registro de Slash Commands.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ================= LÓGICA DE USUARIOS COMÚN =================

async function handleRegisterMain(interaction, rawId) {
  const group = await getUserGroup(interaction);
  if (!group || !GROUP_CONFIG[group]) {
    return "❌ You must have a valid group role (**Elite Four** or **Gym Leader**).";
  }
  const id = cleanGameId(rawId);
  if (!id) return "❌ ID must be exactly 16 digits.";
  if (await isGameIdAlreadyUsed(id, group, interaction.user.id)) {
    return `❌ ID \`${id}\` is already registered by another user in **${getGroupLabel(group)}**.`;
  }

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
  if (await isGameIdAlreadyUsed(secId, group, interaction.user.id)) {
    return `❌ ID \`${secId}\` is already registered by another user in **${getGroupLabel(group)}**.`;
  }

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
  if (!group) return "❌ No active group detected (**Elite Four** or **Gym Leader** required).";

  if (await isGameIdAlreadyUsed(newId, group, interaction.user.id)) {
    return `❌ ID \`${newId}\` is already being used by another user in **${getGroupLabel(group)}**.`;
  }

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) return "❌ You must register first before changing your ID.";

  if (oldData.main_id && oldData.main_id !== newId) await setOnlineStatus("offline", oldData.main_id, group);
  const updated = buildUserData(oldData, interaction, { main_id: newId, sec_id: oldData.sec_id || null });
  await saveSingleUser(interaction.user.id, updated, group);

  return `🔄 **Game ID updated in ${getGroupLabel(group)}**\n🆔 New ID: \`${updated.main_id}\`\n👤 Display Name: **${updated.name}**\n📡 Heartbeat Name: **${updated.heartbeatName}**`;
}

async function handleUpdateHeartbeatName(interaction, rawHbName) {
  const hbName = String(rawHbName || "").trim();
  if (!hbName) return "❌ Invalid heartbeat name.";
  const group = await getUserGroup(interaction);
  if (!group) return "❌ No valid group detected.";

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) return "❌ You must register your Game ID first.";
  const updated = buildUserData(oldData, interaction, { heartbeatName: hbName });
  await saveSingleUser(interaction.user.id, updated, group);

  return `✅ **Heartbeat Name updated in ${getGroupLabel(group)}**\n👤 Display Name: **${updated.name}**\n📡 Heartbeat Name: **${updated.heartbeatName}**`;
}

// ================= EVENTOS =================

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Principal (Headless Mode) conectado como ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (err) {
    console.error("Error registrando Slash Commands:", err);
  }

  try {
    const ch = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
    if (ch) await sendPanel(ch);
  } catch (err) {
    console.error("Error enviando el panel:", err);
  }

  startDailyScheduler();
});

client.on("interactionCreate", async (interaction) => {
  try {
    // ---------------------------------------------------------
    // 1. SLASH COMMANDS
    // ---------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "register") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleRegisterMain(interaction, interaction.options.getString("id")));
      }
      if (commandName === "add_sec") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleAddSecondary(interaction, interaction.options.getString("id")));
      }
      if (commandName === "change") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleChangeMainId(interaction, interaction.options.getString("id")));
      }
      if (commandName === "heartbeat_name") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleUpdateHeartbeatName(interaction, interaction.options.getString("name")));
      }
      if (commandName === "online_count") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const lines = [];
        for (const group of Object.keys(GROUP_CONFIG)) {
          const count = (await getOnlineUsersByGroup(group)).length;
          lines.push(`• **${getGroupLabel(group)}**: \`${count}/${MAX_ONLINE_PER_GROUP}\` online`);
        }
        return interaction.editReply(`## 🟢 Online Users\n\n${lines.join("\n")}`);
      }
      if (commandName === "online") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ You need the **Elite Four** or **Gym Leader** role.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) return interaction.editReply("❌ Register your 16-digit Game ID first.");

        const { group, userData } = found;
        if ((await getOnlineIDs(group)).length >= MAX_ONLINE_PER_GROUP) {
          return interaction.editReply(`❌ The **${getGroupLabel(group)}** group is full.`);
        }
        const ok = await setOnlineStatus("online", userData.main_id, group);
        return interaction.editReply(
          ok ? `🟢 Main account is now **ONLINE** in **${getGroupLabel(group)}**.` : "❌ Could not set account online."
        );
      }
      if (commandName === "online_sec") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.sec_id) return interaction.editReply("❌ No secondary ID registered.");
        const ok = await setOnlineStatus("online", found.userData.sec_id, found.group);
        return interaction.editReply(
          ok ? `🟢 Secondary account is now **ONLINE** in **${getGroupLabel(found.group)}**.` : "❌ Could not set secondary online."
        );
      }
      if (commandName === "offline") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ No active group detected.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found) return interaction.editReply("❌ You are not registered.");

        for (const grp of Object.keys(GROUP_CONFIG)) {
          if (found.userData.main_id) await setOnlineStatus("offline", found.userData.main_id, grp);
          if (found.userData.sec_id) await setOnlineStatus("offline", found.userData.sec_id, grp);
        }

        return interaction.editReply(`🔴 **${found.userData.name}** is now **OFFLINE** in **${getGroupLabel(found.group)}**.`);
      }
      if (commandName === "list") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ Select an active group first.");
        const users = await getUsers(group);
        if (!Object.keys(users).length) return interaction.editReply("📭 No users registered.");
        let msg = `📋 **Registered users in ${getGroupLabel(group)}:**\n\n`;
        for (const u of Object.values(users)) msg += `👤 **${u.name}** | 📡 \`${u.heartbeatName}\` → \`${u.main_id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }
      if (commandName === "online_list") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No active group selected.");
        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);
        let msg = `🟢 **Online in ${getGroupLabel(group)}:**\n\n`;
        for (const u of onlineUsers) msg += `• ${u.label} — \`${u.id}\`\n`;
        return interaction.editReply(msg.slice(0, 1950));
      }
      if (commandName === "change_rol") {
        const userGroups = getMemberSelectableRoles(interaction.member);
        if (userGroups.length < 2) {
          return interaction.reply({
            content: "⚠️ You only have one group role. You need both **Elite Four** and **Gym Leader** to switch.",
            flags: MessageFlags.Ephemeral
          });
        }
        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder()
          .setCustomId("role_select")
          .setPlaceholder("Select your active group")
          .addOptions(userGroups.map((g) => ({ label: getGroupLabel(g), value: g })));
        return interaction.reply({
          content: `🎭 Current active group: **${getGroupLabel(currentRole)}**\nSelect your new active group:`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (commandName === "schedule_events") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const mode = interaction.options.getString("mode");
        const schedules = await loadSchedules();

        if (mode === "stop") {
          delete schedules[interaction.user.id];
          await saveSchedules(schedules);
          return interaction.editReply("🛑 Your daily auto-schedule has been stopped.");
        }

        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ You need an active group (**Elite Four** or **Gym Leader**).");
        const userData = await getUser(interaction.user.id, group);
        if (!userData?.main_id) return interaction.editReply("❌ Register your Game ID first.");

        const onH = interaction.options.getInteger("online_hour");
        const onM = interaction.options.getInteger("online_minute") ?? 0;
        const offH = interaction.options.getInteger("offline_hour");
        const offM = interaction.options.getInteger("offline_minute") ?? 0;

        if (onH === null || offH === null || onH < 0 || onH > 23 || offH < 0 || offH > 23 || onM < 0 || onM > 59 || offM < 0 || offM > 59) {
          return interaction.editReply("❌ Provide valid UTC hours (0-23) and minutes (0-59).");
        }

        schedules[interaction.user.id] = {
          group,
          main_id: userData.main_id,
          online_hour: onH,
          online_minute: onM,
          offline_hour: offH,
          offline_minute: offM
        };
        await saveSchedules(schedules);
        return interaction.editReply(
          `⏰ **Daily Schedule Saved (UTC)**\n🟢 Online: \`${String(onH).padStart(2, "0")}:${String(onM).padStart(2, "0")}\`\n🔴 Offline: \`${String(offH).padStart(2, "0")}:${String(offM).padStart(2, "0")}\``
        );
      }
      if (commandName === "add_vip") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!isChampion(interaction)) return interaction.editReply("❌ Only **Champion** can add VIP IDs.");
        const vipId = cleanGameId(interaction.options.getString("id"));
        if (!vipId) return interaction.editReply("❌ VIP ID must be 16 digits.");
        const group = (await getUserGroup(interaction)) || "Elite_Four";
        await addVipID(vipId, group);
        return interaction.editReply(`👑 VIP ID \`${vipId}\` added to **${getGroupLabel(group)}**.`);
      }
      if (commandName === "set_offline") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!isChampion(interaction)) return interaction.editReply("❌ Only **Champion** can force users offline.");
        const group = (await getUserGroup(interaction)) || "Elite_Four";
        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`force_offline_${group}`)
          .setPlaceholder("Select user to force offline")
          .addOptions(onlineUsers.slice(0, 25).map((u) => ({ label: u.label.slice(0, 95), description: u.id, value: u.id })));
        return interaction.editReply({
          content: `🛡️ Select a user in **${getGroupLabel(group)}** to force offline:`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }
    }

    // ---------------------------------------------------------
    // 2. BOTONES DEL PANEL
    // ---------------------------------------------------------
    if (interaction.isButton()) {
      const { customId } = interaction;

      if (customId === "register") {
        const modal = new ModalBuilder().setCustomId("reg_modal").setTitle("Register Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit Game ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }
      if (customId === "add_sec") {
        const modal = new ModalBuilder().setCustomId("sec_modal").setTitle("Add Secondary Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit Secondary ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }
      if (customId === "change") {
        const modal = new ModalBuilder().setCustomId("change_modal").setTitle("Change Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("New 16-Digit ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }
      if (customId === "heartbeat_name") {
        const modal = new ModalBuilder().setCustomId("heartbeat_modal").setTitle("Set Heartbeat Name");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("name")
              .setLabel("Exact name shown in your heartbeat")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }
      if (customId === "gp") {
        if (!isChampion(interaction)) {
          return interaction.reply({ content: "❌ Only **Champion** can add VIP IDs.", flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder().setCustomId("vip_modal").setTitle("Add VIP Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit VIP ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }
      if (customId === "schedule") {
        const modal = new ModalBuilder().setCustomId("schedule_modal").setTitle("Auto Schedule (UTC)");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("online_time")
              .setLabel("Online Time UTC (HH:MM or 'stop')")
              .setPlaceholder("08:00")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("offline_time")
              .setLabel("Offline Time UTC (HH:MM)")
              .setPlaceholder("22:00")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
          )
        );
        return interaction.showModal(modal);
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (customId === "online") {
        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ You must have the **Elite Four** or **Gym Leader** role.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) return interaction.editReply("❌ Register your 16-digit Game ID first.");

        const { group, userData } = found;
        if ((await getOnlineIDs(group)).length >= MAX_ONLINE_PER_GROUP) {
          return interaction.editReply(`❌ The **${getGroupLabel(group)}** group is full.`);
        }
        const ok = await setOnlineStatus("online", userData.main_id, group);
        return interaction.editReply(
          ok ? `🟢 Main account is now **ONLINE** in **${getGroupLabel(group)}**.` : "❌ Could not set online."
        );
      }

      if (customId === "online_sec") {
        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.sec_id) return interaction.editReply("❌ No secondary ID registered.");
        const ok = await setOnlineStatus("online", found.userData.sec_id, found.group);
        return interaction.editReply(
          ok ? `🟢 Secondary account is now **ONLINE** in **${getGroupLabel(found.group)}**.` : "❌ Could not set secondary online."
        );
      }

      if (customId === "offline") {
        const activeGroup = await getUserGroup(interaction);
        const found = await findUserRegistration(interaction.user.id, activeGroup);
        if (!found) return interaction.editReply("❌ You are not registered.");

        for (const grp of Object.keys(GROUP_CONFIG)) {
          if (found.userData.main_id) await setOnlineStatus("offline", found.userData.main_id, grp);
          if (found.userData.sec_id) await setOnlineStatus("offline", found.userData.sec_id, grp);
        }
        return interaction.editReply(`🔴 Set **OFFLINE** in **${getGroupLabel(found.group)}**.`);
      }

      if (customId === "group_status") {
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No active group selected.");

        const onlineUsers = await getOnlineUsersByGroup(group);
        const allUsers = await getUsers(group);
        const totalReg = Object.keys(allUsers).length;

        const onlineText = onlineUsers.length
          ? onlineUsers.map((u) => `• **${u.label}** — \`${u.id}\``).join("\n")
          : "*⚫ No users online right now.*";

        const statusEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle(`📡 ${getGroupLabel(group)} — Group Status`)
          .setDescription(
            `**🟢 Currently Online (${onlineUsers.length}/${MAX_ONLINE_PER_GROUP}):**\n${onlineText}\n\n` +
            `📋 **Total Registered Members:** \`${totalReg}\``
          );

        const subRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("list").setLabel("View All Registered Members").setEmoji("📋").setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ embeds: [statusEmbed], components: [subRow] });
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

      if (customId === "change_role") {
        const memberGroups = getMemberSelectableRoles(interaction.member);
        if (memberGroups.length < 2) {
          return interaction.editReply("❌ You need both **Elite Four** and **Gym Leader** roles to switch groups.");
        }
        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder()
          .setCustomId("role_select")
          .setPlaceholder("Select your active group")
          .addOptions(memberGroups.map((g) => ({ label: getGroupLabel(g), value: g })));
        return interaction.editReply({
          content: `🎭 Current active group: **${getGroupLabel(currentRole)}**\nSelect your new active group:`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      if (customId === "admin_and_guide") {
        const guideEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📖 Headless System Guide")
          .setDescription(
            "• **🟢 Online / 🔴 Offline:** Activates or stops your registered IDs in your active group.\n" +
            "• **⚡ Online Sec:** Puts your secondary account online.\n" +
            "• **🎭 Switch Group:** Switch between **Elite Four** and **Gym Leader** if you hold both roles.\n" +
            "• **🆔 Register / ➕ Add Sec / 🔄 Change:** Links or updates your game IDs.\n" +
            "• **🏷️ Heartbeat Name:** Must match the exact name your bot/host sends in the logs.\n" +
            "• **⏰ Auto Schedule:** Configures automatic daily Online/Offline times in UTC."
          );

        const components = [];
        if (isChampion(interaction)) {
          const adminRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("gp").setLabel("Add VIP ID").setEmoji("👑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("set_offline").setLabel("Force User Offline").setEmoji("🛡️").setStyle(ButtonStyle.Danger)
          );
          components.push(adminRow);
        }

        return interaction.editReply({ embeds: [guideEmbed], components });
      }

      if (customId === "set_offline") {
        if (!isChampion(interaction)) return interaction.editReply("❌ Only **Champion** can force users offline.");
        const targetGroup = (await getUserGroup(interaction)) || "Elite_Four";
        const onlineUsers = await getOnlineUsersByGroup(targetGroup);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(targetGroup)}**.`);

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`force_offline_${targetGroup}`)
          .setPlaceholder("Select user to force offline")
          .addOptions(onlineUsers.slice(0, 25).map((u) => ({ label: u.label.slice(0, 95), description: u.id, value: u.id })));
        return interaction.editReply({
          content: `🛡️ Select a user in **${getGroupLabel(targetGroup)}** to force offline:`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }
    }

    // ---------------------------------------------------------
    // 3. SELECT MENUS
    // ---------------------------------------------------------
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;

      if (customId === "role_select") {
        const selected = interaction.values[0];
        await setActiveRole(interaction.user.id, selected);
        return interaction.update({ content: `✅ Active group set to **${getGroupLabel(selected)}**.`, components: [] });
      }

      if (customId.startsWith("force_offline_")) {
        if (!isChampion(interaction)) {
          return interaction.update({ content: "❌ Permission denied.", components: [] });
        }
        const targetGroup = customId.replace("force_offline_", "");
        const targetGameId = interaction.values[0];
        await setOnlineStatus("offline", targetGameId, targetGroup);
        return interaction.update({
          content: `🛡️ Forced ID \`${targetGameId}\` **OFFLINE** in **${getGroupLabel(targetGroup)}**.`,
          components: []
        });
      }
    }

    // ---------------------------------------------------------
    // 4. MODALS
    // ---------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;

      if (customId === "reg_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleRegisterMain(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "sec_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleAddSecondary(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "change_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleChangeMainId(interaction, interaction.fields.getTextInputValue("id")));
      }
      if (customId === "heartbeat_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await handleUpdateHeartbeatName(interaction, interaction.fields.getTextInputValue("name")));
      }
      if (customId === "vip_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!isChampion(interaction)) return interaction.editReply("❌ Only **Champion** can add VIP IDs.");
        const vipId = cleanGameId(interaction.fields.getTextInputValue("id"));
        if (!vipId) return interaction.editReply("❌ VIP ID must be exactly 16 digits.");
        const group = (await getUserGroup(interaction)) || "Elite_Four";
        await addVipID(vipId, group);
        return interaction.editReply(`👑 VIP ID \`${vipId}\` added to **${getGroupLabel(group)}**.`);
      }
      if (customId === "schedule_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rawOnline = interaction.fields.getTextInputValue("online_time").trim().toLowerCase();
        const rawOffline = (interaction.fields.getTextInputValue("offline_time") || "").trim();
        const schedules = await loadSchedules();

        if (rawOnline === "stop") {
          delete schedules[interaction.user.id];
          await saveSchedules(schedules);
          return interaction.editReply("🛑 Your daily auto-schedule has been stopped.");
        }

        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ You need an active group (**Elite Four** or **Gym Leader**).");
        const userData = await getUser(interaction.user.id, group);
        if (!userData?.main_id) return interaction.editReply("❌ Register your Game ID first.");

        const mOn = rawOnline.match(/^(\d{1,2}):(\d{2})$/);
        const mOff = rawOffline.match(/^(\d{1,2}):(\d{2})$/);
        if (!mOn || !mOff) return interaction.editReply("❌ Invalid format. Use `HH:MM` (e.g. `08:00` and `22:00`) or write `stop`.");

        const onH = Number(mOn[1]);
        const onM = Number(mOn[2]);
        const offH = Number(mOff[1]);
        const offM = Number(mOff[2]);

        if (onH > 23 || offH > 23 || onM > 59 || offM > 59) {
          return interaction.editReply("❌ Invalid time values. Hours must be 0-23 and minutes 0-59.");
        }

        schedules[interaction.user.id] = {
          group,
          main_id: userData.main_id,
          online_hour: onH,
          online_minute: onM,
          offline_hour: offH,
          offline_minute: offM
        };
        await saveSchedules(schedules);
        return interaction.editReply(
          `⏰ **Daily Schedule Saved (UTC)**\n🟢 Online: \`${String(onH).padStart(2, "0")}:${String(onM).padStart(2, "0")}\`\n🔴 Offline: \`${String(offH).padStart(2, "0")}:${String(offM).padStart(2, "0")}\``
        );
      }
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Internal error.", flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.editReply({ content: "❌ Internal error." }).catch(() => {});
    }
  }
});

client.on("error", (err) => console.error("Discord client error:", err));

client.login(TOKEN);
