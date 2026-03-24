const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(session({
  secret: 'resmatematch_secret_2026',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/resmatematch',
    ttl: 3 * 60 * 60 // 3 hours
  }),
  cookie: { maxAge: 1000 * 60 * 60 * 3 } // 3 hours
}));

// Connect to MongoDB via local server first; fallback to Atlas if MONGODB_URI is set
function normalizeMongoURI(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  let fixed = uri.trim();
  // support debug strings like "MONGODB_URI = mongodb+srv://..."
  fixed = fixed.replace(/^MONGODB_URI\s*=\s*/i, '');
  // remove surrounding quotes if added by mistake
  if ((fixed.startsWith('"') && fixed.endsWith('"')) || (fixed.startsWith("'") && fixed.endsWith("'"))) {
    fixed = fixed.slice(1, -1).trim();
  }
  return fixed;
}

const rawMongoURI = process.env.MONGODB_URI;
console.log("rawMongoURI:", rawMongoURI);
let mongoURI = normalizeMongoURI(rawMongoURI);
console.log("normalized mongoURI:", mongoURI);
let mongoStatus = "disconnected";
let mongoErrorMsg = null;
let mongoMessage = "";

const fallbackURI = "mongodb://127.0.0.1:27017/resmatematch";
const uriCandidates = [mongoURI, fallbackURI].filter(Boolean);

const mongoOptions = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
};

async function connectToMongo() {
  if (!mongoURI) {
    mongoMessage = "MONGODB_URI is not set; trying local fallback.";
  }

  for (const candidate of uriCandidates) {
    if (!/^mongodb(?:\+srv)?:\/\//i.test(candidate)) {
      console.error("Skipping invalid MongoDB URI scheme:", candidate);
      continue;
    }

    try {
      await mongoose.connect(candidate, mongoOptions);
      mongoURI = candidate;
      mongoStatus = "connected";
      mongoErrorMsg = null;
      console.log("MongoDB connected to", candidate);
      return;
    } catch (err) {
      mongoStatus = "error";
      mongoErrorMsg = err.message || err.toString();
      mongoMessage = `Failed connection for ${candidate}`;
      console.error(`MongoDB connection error for ${candidate}:`, err);
    }
  }

  if (mongoStatus !== "connected") {
    mongoStatus = "disconnected";
    console.warn("MongoDB not connected after attempting all URIs.");
  }
}

connectToMongo().catch(err => {
  mongoStatus = "error";
  mongoErrorMsg = err.message || err.toString();
  console.error("MongoDB connection initializer failed:", err);
});

mongoose.connection.on("connected", () => {
  mongoStatus = "connected";
  console.log("MongoDB connection established.");
});

mongoose.connection.on("error", (err) => {
  mongoStatus = "error";
  mongoErrorMsg = err.message || err.toString();
  console.error("MongoDB connectivity error:", err);
});

mongoose.connection.on("disconnected", () => {
  mongoStatus = "disconnected";
  console.warn("MongoDB disconnected.");
});

function isDbConnected() {
  return mongoStatus === "connected";
}

function dbErrorHint() {
  if (mongoStatus === 'invalid') {
    return "The MONGODB_URI is malformed or missing the mongodb:// or mongodb+srv:// prefix.";
  }
  if (mongoStatus === 'error') {
    return `DB error: ${mongoErrorMsg}`;
  }
  if (mongoStatus === 'disconnected') {
    return "Database is not connected yet. Ensure your connection string and Atlas whitelist are correct.";
  }
  return "";
}

app.get('/health', (req, res) => {
  if (isDbConnected()) {
    return res.status(200).json({ status: 'ok', db: 'connected', uri: mongoURI });
  }
  return res.status(503).json({ status: 'unavailable', dbStatus: mongoStatus, dbError: dbErrorHint(), uri: mongoURI, message: mongoMessage });
});

// Define schemas
const profileSchema = new mongoose.Schema({
  mode: { type: String, enum: ['date','friend','both'], default: 'date' },
  gender: { type: String, enum: ['male','female','nonbinary','other'], default: 'other' },
  username: { type: String, unique: true, sparse: true },
  alias: String,
  password: String,
  contactEmail: { type: String, unique: true, sparse: true },
  contactPhone: { type: String, unique: true, sparse: true },
  verificationCode: String,
  verified: { type: Boolean, default: false },
  about: String,
  tags: [String],
  picture: String,
  blurred: { type: Boolean, default: false },
});

const likeSchema = new mongoose.Schema({
  fromId: mongoose.Schema.Types.ObjectId,
  toId: mongoose.Schema.Types.ObjectId,
});

const messageRequestSchema = new mongoose.Schema({
  fromId: mongoose.Schema.Types.ObjectId,
  toId: mongoose.Schema.Types.ObjectId,
  status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});

const matchSchema = new mongoose.Schema({
  fromId: mongoose.Schema.Types.ObjectId,
  toId: mongoose.Schema.Types.ObjectId,
  roomId: String,
});

const messageSchema = new mongoose.Schema({
  roomId: String,
  senderId: mongoose.Schema.Types.ObjectId,
  senderAlias: String,
  text: String,
  createdAt: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
});

const notificationSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  fromId: mongoose.Schema.Types.ObjectId,
  type: { type: String, default: 'info' }, // info | like | messageRequest | requestApproved | requestDenied
  message: String,
  createdAt: { type: Date, default: Date.now },
});

const postSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  alias: String,
  content: String,
  createdAt: { type: Date, default: Date.now },
});

const Profile = mongoose.model("Profile", profileSchema);
const Like = mongoose.model("Like", likeSchema);
const MessageRequest = mongoose.model("MessageRequest", messageRequestSchema);
const Match = mongoose.model("Match", matchSchema);
const Message = mongoose.model("Message", messageSchema);
const Notification = mongoose.model("Notification", notificationSchema);
const Post = mongoose.model("Post", postSchema);

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/uploads", express.static("uploads"));

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function romanticRewrite(text) {
  return `✨ Someone who ${text.toLowerCase()}… hoping to find a beautiful connection, butterflies, soft laughter and meaningful moments together 💕`;
}

function friendlyRewrite(text) {
  return `😄 Someone who ${text.toLowerCase()}… just looking for good vibes, real laughs and a genuine campus friendship 🤝`;
}

function calculateMatchScore(a, b) {
  let score = 35;
  const aWords = a.about.toLowerCase().split(/\W+/).filter(Boolean);
  const bWords = b.about.toLowerCase().split(/\W+/).filter(Boolean);
  const commonWords = aWords.filter((word) => bWords.includes(word)).length;
  score += Math.min(commonWords * 4, 35);
  if (a.mode === b.mode) score += 25;
  const commonTags = a.tags.filter(tag => b.tags.includes(tag)).length;
  score += commonTags * 10;
  return Math.min(score, 98);
}

async function getCounts(userId) {
  const [likes, notifications, messageRequests, unopenedMessages] = await Promise.all([
    Like.countDocuments({ toId: userId }),
    Notification.countDocuments({ userId }),
    MessageRequest.countDocuments({ toId: userId, status: 'pending' }),
    Message.countDocuments({ 
      $or: [
        { roomId: new RegExp(`_${userId}$`) },
        { roomId: new RegExp(`^room_${userId}_`) }
      ],
      senderId: { $ne: userId },
      read: false
    })
  ]);
  return {
    likes,
    notifications,
    requests: messageRequests,
    unopenedMessages
  };
}

function pageShell(title, body, profileId = null, counts = {}) {
  const headerNav = profileId ? `
    <div class="header-nav">
      <a href="/" class="nav-item ${title === 'Home' ? 'active' : ''}"><span class="nav-icon">🏠</span><span class="nav-label">Home</span></a>
      <a href="/discover/${profileId}" class="nav-item ${title === 'Discover' ? 'active' : ''}"><span class="nav-icon">🔍</span><span class="nav-label">Discover</span></a>
      <a href="/messages/${profileId}" class="nav-item ${title === 'Messages' ? 'active' : ''}"><span class="nav-icon">💬</span><span class="nav-label">Messages${counts.unopenedMessages ? ` <span class="badge">${counts.unopenedMessages}</span>` : ''}</span></a>
      <a href="/requests/${profileId}" class="nav-item ${title === 'Requests' ? 'active' : ''}"><span class="nav-icon">👥</span><span class="nav-label">Requests${counts.requests ? ` <span class="badge">${counts.requests}</span>` : ''}</span></a>
      <a href="/notifications/${profileId}" class="nav-item ${title === 'Notifications' ? 'active' : ''}"><span class="nav-icon">🔔</span><span class="nav-label">Notifications${counts.notifications ? ` <span class="badge">${counts.notifications}</span>` : ''}</span></a>
      <a href="/profile/${profileId}" class="nav-item ${title.includes('Profile') ? 'active' : ''}"><span class="nav-icon">👤</span><span class="nav-label">Profile</span></a>
      <a href="/matches/${profileId}" class="nav-item ${title === 'Matches' ? 'active' : ''}"><span class="nav-icon">❤️</span><span class="nav-label">Matches</span></a>
      <a href="/newsfeed" class="nav-item ${title === 'News Feed' ? 'active' : ''}"><span class="nav-icon">📰</span><span class="nav-label">Feed</span></a>
    </div>
  ` : `
    <div class="header-nav">
      <a href="/" class="nav-item active"><span class="nav-icon">🏠</span><span class="nav-label">Home</span></a>
      <a href="/newsfeed" class="nav-item ${title === 'News Feed' ? 'active' : ''}"><span class="nav-icon">📰</span><span class="nav-label">Feed</span></a>
    </div>
  `;

  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1.0"/><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f0f2f5;color:#050505}
a{color:#0a66c2;text-decoration:none}a:hover{text-decoration:underline}
#fb-header{background:white;border-bottom:1px solid #cce1e6;padding:8px 0;position:sticky;top:0;z-index:100;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.header-content{max-width:1400px;margin:0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between}
.fb-logo{font-size:28px;font-weight:bold;color:#0a66c2;margin-right:20px}
.header-nav{display:flex;gap:0;flex:1;border-bottom:1px solid #cce1e6}
.nav-item{display:flex;align-items:center;gap:6px;padding:12px 16px;color:#65676b;text-decoration:none;border-bottom:3px solid transparent;transition:all .2s ease;cursor:pointer;white-space:nowrap;position:relative;font-weight:500;font-size:14px}
.nav-item:hover{color:#0a66c2;background:#f0f2f5}
.nav-item.active{color:#0a66c2;border-bottom-color:#0a66c2}
.nav-icon{font-size:18px}
.nav-label{font-size:13px}
.badge{background:#e41e3f;color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;margin-left:4px}
#main-wrapper{max-width:1400px;margin:0 auto;padding:16px;display:grid;grid-template-columns:0 1fr 0;gap:20px}
@media (min-width:1280px){#main-wrapper{grid-template-columns:280px 1fr 320px}}
.sidebar{background:white;border-radius:8px;padding:16px;height:fit-content;border:1px solid #cce1e6}
.sidebar h3{font-size:13px;font-weight:600;color:#65676b;margin-bottom:12px}
.sidebar a{display:block;padding:8px 0;color:#0a66c2;font-size:14px}
.sidebar a:hover{color:#004182}
#content{background:white;border-radius:8px;padding:28px;border:1px solid #cce1e6;min-height:calc(100vh - 200px)}
#content h1{font-size:28px;color:#050505;margin-bottom:20px;font-weight:600}
#content h2{font-size:18px;color:#050505;margin-top:20px;margin-bottom:12px;font-weight:600}
#content h3{font-size:16px;color:#050505;margin-top:16px;margin-bottom:10px;font-weight:600}
.hero{background:linear-gradient(135deg,#0a66c2 0%,#0d78c1 100%);color:white;border-radius:8px;padding:32px;margin-bottom:20px;text-align:center}
.hero h1{color:white;margin-bottom:12px}
.hero p{font-size:15px;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin:16px 0}
.card{background:white;border:1px solid #cce1e6;border-radius:8px;padding:16px;transition:all .2s ease}
.card:hover{box-shadow:0 2px 4px rgba(0,0,0,.1)}
.card img,.profile-cover{width:100%;border-radius:8px;margin-bottom:12px;display:block}
.card h3{font-size:15px;font-weight:600;color:#050505;margin:12px 0 8px}
.card p{font-size:13px;color:#65676b;line-height:1.4;margin:8px 0}
.card .tags{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.pill{display:inline-block;padding:6px 12px;border-radius:999px;background:#e7f3ff;color:#0a66c2;font-size:12px;font-weight:600}
.card .top-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.form{background:white;border:1px solid #cce1e6;border-radius:8px;padding:20px;margin:16px 0}
.form h2{margin-top:0}
.form label{display:block;font-weight:600;color:#050505;font-size:14px;margin:16px 0 6px}
.form label:first-of-type{margin-top:0}
input,textarea,select{width:100%;padding:10px 12px;border:1px solid #b0b8c1;border-radius:6px;font-size:14px;font-family:inherit;margin:6px 0 12px;transition:all .2s ease}
input:focus,textarea:focus,select:focus{border-color:#0a66c2;outline:none;box-shadow:0 0 0 3px rgba(10,102,194,.15)}
textarea{min-height:100px;resize:vertical}
.btn,button{background:#0a66c2;color:white;border:none;border-radius:6px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;transition:all .2s ease;margin:6px 6px 6px 0}
.btn:hover,button:hover{background:#004182}
.btn-blue{background:#0a66c2}.btn-blue:hover{background:#004182}
.btn-pink{background:#e41e3f}.btn-pink:hover{background:#c91a2e}
.btn-gray{background:#b0b8c1}.btn-gray:hover{background:#96a0aa}
.top-actions{display:flex;flex-wrap:wrap;gap:8px}
.msg{background:#f0f2f5;padding:12px 16px;border-radius:8px;margin:8px 0;border-left:3px solid #0a66c2}
.conversation-card{cursor:pointer;transition:all .2s ease;display:flex;align-items:center;gap:12px;padding:12px}
.conversation-card:hover{background:#f0f2f5;border-radius:8px}
.conversation-card h4{margin:0;font-weight:600;color:#050505}
.conversation-card p{margin:4px 0;color:#65676b;font-size:13px}
.blurred{filter:blur(6px)}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}
.feature{background:white;border:1px solid #cce1e6;border-radius:8px;padding:16px;text-align:center}
.feature h3{font-size:14px;margin:8px 0}
.feature p{font-size:12px;color:#65676b}
.footer-custom{text-align:center;padding:20px;color:#65676b;font-size:12px;margin-top:20px}
@media (max-width:1279px){#main-wrapper{grid-template-columns:1fr}.sidebar{display:none}}
@media (max-width:768px){#content{padding:16px}.hero{padding:20px}.grid{grid-template-columns:1fr}.nav-label{display:none}}
.chat-wrap{background:white;border:1px solid #cce1e6;border-radius:8px;padding:20px}
#messages{height:400px;overflow-y:auto;background:#f0f2f5;border:1px solid #cce1e6;border-radius:8px;padding:12px;margin:12px 0}
.chat-row{display:flex;gap:8px;margin-top:12px}
.chat-row input{flex:1;margin:0}
.chat-row button{margin:0;flex-shrink:0}
</style></head><body>
<div id="fb-header">
  <div class="header-content">
    <div class="fb-logo">💘 Resmate Match</div>
  </div>
  ${headerNav}
</div>
<div id="main-wrapper">
  <div class="sidebar">
    <h3>QUICK LINKS</h3>
    <a href="/discover/${profileId || '#'}">🔍 Discover People</a>
    <a href="/messages/${profileId || '#'}">💬 Messages</a>
    <a href="/profile/${profileId || '#'}">👤 My Profile</a>
    <a href="/logout" style="color:#e41e3f;margin-top:12px;">🚪 Logout</a>
  </div>
  <div id="content">
    ${body}
  </div>
  <div class="sidebar">
    <h3>ONLINE FRIENDS</h3>
    <p style="font-size:13px;color:#65676b;">Online friends will appear here</p>
  </div>
</div>
<div class="footer-custom">BY JABULANI SHIBAMBO @0725601834 CAPITEC ACCEPTED</div>
</body></html>`;
}

app.get("/", async (req, res) => {
  try {
    if (!isDbConnected()) {
      const hint = dbErrorHint();
      const errMsg = `<div style="padding:24px; font-family:Arial, Helvetica, sans-serif; background:#fff;color:#b91c1c;border:2px solid #fca5a5;border-radius:12px;"><h2>Error loading profiles</h2><p>${escapeHtml(hint)}</p><p>Current URI: ${escapeHtml(mongoURI)}</p><p>${escapeHtml(mongoMessage || 'Check MONGODB_URI and Atlas IP whitelist.')}</p></div>`;
      return res.status(500).send(pageShell("Error", errMsg));
    }

    const profiles = await Profile.find();
    const profileCards = profiles.map(p => `<div class="card"><img class="blurred" src="${p.picture ? '/uploads/' + p.picture : 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=900&q=80'}" alt="profile"/><span class="tag ${p.mode}">${p.mode === "date" ? "❤️ Date My Resmate" : p.mode === "friend" ? "🤝 Friend My Resmate" : "🌟 Both"}</span><h3>${escapeHtml(p.alias)}</h3><p>${escapeHtml(p.about)}</p><div class="tags">${p.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><div class="top-actions"><a class="btn" href="/profile/${p._id}">View Profile</a></div></div>`).join("");
    const html = `<div class="hero"><h1>🎉 Resmate Match</h1><p>Create an anonymous profile, send view requests to see profiles, send message requests to chat, and react with likes.</p><p>📍 Campus: FNB 74 Govon Mbheki Metrorez, Gqeberha. For best results, use a campus photo if available.</p><p><a class="btn btn-blue" href="/login">Login with Username + Password</a></p></div><div class="feature-grid"><div class="feature"><h3>❤️ Date My Resmate</h3><p>Descriptions are rewritten in a romantic way.</p></div><div class="feature"><h3>🤝 Friend My Resmate</h3><p>Descriptions are rewritten in a friendly way.</p></div><div class="feature"><h3>👀 View Requests</h3><p>Send requests to view anonymous profiles.</p></div><div class="feature"><h3>💬 Message Requests</h3><p>Send requests to start chatting.</p></div></div><div class="form"><h2>Create Anonymous Profile</h2><form method="POST" action="/create" enctype="multipart/form-data"><label>Choose option</label><select name="mode" required><option value="date">Date My Resmate ❤️</option><option value="friend">Friend My Resmate 🤝</option></select><label>Username (for login)</label><input name="username" placeholder="Example: SilentHeart or ChillBuddy" required/><label>Display name (alias)</label><input name="alias" placeholder="Your anonymous name shown in profiles" required/><label>Gender</label><select name="gender" required><option value="male">Male</option><option value="female">Female</option><option value="nonbinary">Nonbinary</option><option value="other">Other</option></select><label>Mode</label><select name="mode" required><option value="date">Date My Resmate ❤️</option><option value="friend">Friend My Resmate 🤝</option><option value="both">Both (wide socialization)</option></select><label>Password (keep this safe)</label><input type="password" name="password" placeholder="Enter password" required/><label>Email (verification code will be sent here)</label><input type="email" name="contactEmail" placeholder="your.email@example.com" required/><label>Phone (optional backup for verification)</label><input name="contactPhone" placeholder="e.g. +27825601834"/><label>Describe yourself</label><textarea name="about" placeholder="Example: I enjoy music, laughing, late-night talks, studying together..." required></textarea><label>Personality tags (comma separated)</label><input name="tags" placeholder="introvert, gym lover, night owl, romantic, funny"/><label>Profile picture</label><input type="file" name="picture" accept="image/*"/><label style="display:flex;align-items:center;gap:8px;"><span style="color:#dc2626;font-weight:bold;">TICK TO BLUR PICTURE UNTIL VIEW REQUEST APPROVED</span><input type="checkbox" name="blurred" style="transform:scale(1.1);"/></label><button type="submit">Create Profile</button></form></div><h2 style="color:white;">🌈 Community Profiles</h2><div class="grid">${profileCards || '<div class="form"><p>No profiles yet. Create the first one.</p></div>'}</div><footer style="margin-top:20px;color:white;text-align:center;">BY JABULANI SHIBAMBO @0725601834 CAPITEC ACCEPTED</footer>`;
    res.send(pageShell("Resmate Match", html));
  } catch (err) {
    console.error("Error fetching profiles:", err);
    const errMsg = `<div style="padding:24px; font-family:Arial, Helvetica, sans-serif;
      background:#fff;color:#b91c1c;border:2px solid #fca5a5;border-radius:12px;">
      <h2>Error loading profiles</h2>
      <p>${escapeHtml(err.message || err.toString())}</p>
      <p>Check MONGODB_URI and Atlas IP whitelist (or use local MongoDB).</p>
      </div>`;
    res.status(500).send(pageShell("Error", errMsg));
  }
});

app.get("/login", (req, res) => {
  const loginForm = `<div class="form" style="max-width:480px;margin:24px auto;">` +
    `<h2>Login to your Resmate account</h2>` +
    `<form method="POST" action="/login"><label>Username</label><input name="username" required/><label>Password</label><input type="password" name="password" required/><button type="submit">Login</button></form>` +
    `<p>Or <a href="/">return to create profile</a>.</p></div>`;
  res.send(pageShell("Login", loginForm));
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Please provide username and password");
    const profile = await Profile.findOne({ username: username.trim(), password });
    if (!profile) return res.status(401).send("Invalid username/password");
    if (!profile.verified) return res.status(403).send("Please verify your profile before logging in.");
    req.session.profileId = profile._id.toString();
    res.redirect(`/profile/${profile._id}`);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

app.get("/verify", (req, res) => {
  const verifyForm = `<div class="form" style="max-width:500px;margin:auto"><h2>Verify Your Account</h2><form method="POST" action="/verify">` +
    `<label>Profile ID</label><input name="profileId" required/>` +
    `<label>Verification code</label><input name="code" required/>` +
    `<button type="submit">Verify</button></form></div>`;
  res.send(pageShell("Verify", verifyForm));
});

app.post("/send-message-request", async (req, res) => {
  try {
    if (!req.session.profileId) return res.status(401).send("Please login");
    const { toId } = req.body;
    if (!toId) return res.status(400).send("Invalid request");
    const existing = await MessageRequest.findOne({ fromId: req.session.profileId, toId });
    if (existing) {
      existing.status = 'pending';
      existing.createdAt = new Date();
      await existing.save();
    } else {
      await new MessageRequest({ fromId: req.session.profileId, toId }).save();
    }
    await new Notification({ userId: toId, fromId: req.session.profileId, type: 'messageRequest', message: 'New message request 💬' }).save();
    res.redirect(`/discover/${req.session.profileId}`);
  } catch (err) {
    console.error("Error sending message request:", err);
    res.status(500).send("Error sending request");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get("/newsfeed", async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    const postCards = posts.map(p => `<div class="card"><h3>${escapeHtml(p.alias)}</h3><p>${escapeHtml(p.content)}</p><small>${new Date(p.createdAt).toLocaleString()}</small></div>`).join("");
    let postForm = '';
    if (req.session.profileId) {
      const profile = await Profile.findById(req.session.profileId);
      if (profile) {
        postForm = `<div class="form"><h2>Post a Status</h2><form method="POST" action="/newsfeed"><textarea name="content" placeholder="What's on your mind?" required></textarea><button type="submit">Post</button></form></div>`;
      }
    }
    const html = `<div class="hero"><h1>📰 News Feed</h1><p>Share your thoughts and see what others are posting.</p></div>${postForm}<div class="grid">${postCards || '<div class="form"><p>No posts yet.</p></div>'}</div>`;
    res.send(pageShell("News Feed", html, req.session.profileId));
  } catch (err) {
    console.error("Error loading newsfeed:", err);
    res.status(500).send("Error loading newsfeed");
  }
});

app.post("/newsfeed", async (req, res) => {
  try {
    if (!req.session.profileId) return res.status(401).send("Please login to post");
    const profile = await Profile.findById(req.session.profileId);
    if (!profile) return res.status(404).send("Profile not found");
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).send("Content required");
    const post = new Post({ userId: profile._id, alias: profile.alias, content: content.trim() });
    await post.save();
    res.redirect("/newsfeed");
  } catch (err) {
    console.error("Error posting:", err);
    res.status(500).send("Error posting");
  }
});

app.post("/create", upload.single('picture'), async (req, res) => {
  try {
    const { mode, username, alias, password, contactEmail, contactPhone, about, tags, blurred } = req.body;
    if (!mode || !username || !alias || !password || !about || !contactEmail) return res.status(400).send("Missing required fields (username, alias, password, email, about)");
    
    // Check if email already exists
    const existingEmail = await Profile.findOne({ contactEmail: contactEmail.trim().toLowerCase() });
    if (existingEmail) return res.status(409).send("Email already registered");
    
    // Check if phone already exists (if provided)
    if (contactPhone) {
      const existingPhone = await Profile.findOne({ contactPhone: contactPhone.trim() });
      if (existingPhone) return res.status(409).send("Phone number already registered");
    }
    
    // Check if username already exists
    const existingUsername = await Profile.findOne({ username: username.trim() });
    if (existingUsername) return res.status(409).send("Username already taken");
    
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    let picture = null;
    const genderValue = (gender && ['male','female','nonbinary','other'].includes(gender)) ? gender : 'other';
    const modeValue = (mode && ['date','friend','both'].includes(mode)) ? mode : 'date';
    if (req.file) {
      const filename = Date.now() + '.jpg';
      try {
        await sharp(req.file.buffer).resize(300, 300, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(path.join('uploads', filename));
        picture = filename;
      } catch (sharpErr) {
        console.warn('Sharp conversion failed, saving raw buffer fallback:', sharpErr.message);
        try {
          await fs.promises.writeFile(path.join('uploads', filename), req.file.buffer);
          picture = filename;
        } catch (fsErr) {
          console.error('Failed fallback file save:', fsErr);
          picture = null;
        }
      }
    }
    const rewritten = mode === "date" ? romanticRewrite(about) : friendlyRewrite(about);
    const newProfile = new Profile({
      mode: modeValue,
      gender: genderValue,
      username: username.trim(),
      alias: alias.trim(),
      password,
      contactEmail: contactEmail.trim().toLowerCase(),
      contactPhone: contactPhone ? contactPhone.trim() : undefined,
      verificationCode,
      verified: false,
      about: rewritten,
      tags: tags ? tags.split(',').map(t => t.trim().toLowerCase()) : [],
      picture,
      blurred: blurred === 'on'
    });
    await newProfile.save();
    console.log(`[SIGNUP] Username: ${newProfile.username} | Email: ${newProfile.contactEmail} | Phone: ${newProfile.contactPhone || 'N/A'} | Code: ${verificationCode}`);
    res.send(pageShell("Verify Your Account", `<div class="form" style="max-width:500px;margin:auto;"><h2>Profile created successfully!</h2><p>A verification code has been generated.</p><p><strong>Code: ${verificationCode}</strong></p><p>Copy it and verify here:</p><form method="POST" action="/verify">` +
      `<input type="hidden" name="profileId" value="${newProfile._id}"/><label>Verification code</label><input name="code" required/><button type="submit">Verify now</button></form></div>`));
  } catch (err) {
    console.error("Error creating profile:", err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(409).send(`${field === 'contactEmail' ? 'Email' : field === 'contactPhone' ? 'Phone' : 'Username'} already registered`);
    }
    res.status(500).send("Error creating profile");
  }
});

app.get("/profile/:id", async (req, res) => {
  try {
    const profile = await Profile.findById(req.params.id);
    if (!profile) return res.status(404).send("Profile not found");
    const isOwn = req.session.profileId && req.session.profileId === req.params.id;
    let canView = isOwn;
    if (!canView && req.session.profileId) {
      // Check for approved message request for picture
      const messageRequest = await MessageRequest.findOne({
        $or: [
          { fromId: req.session.profileId, toId: req.params.id, status: 'approved' },
          { fromId: req.params.id, toId: req.session.profileId, status: 'approved' }
        ]
      });
      canView = !!messageRequest;
    }
    // Always show profile, but blur picture if no approved message request
    const verificationStatus = profile.verified ? '<span style="color:green;font-weight:bold;">Verified</span>' : '<span style="color:red;font-weight:bold;">Not verified - <a href="/verify">Verify now</a></span>';
    const counts = await getCounts(req.params.id);
    const html = `<div class="card" style="max-width:700px;margin:auto;"><img class="${canView ? '' : 'blurred'} profile-cover" src="${profile.picture ? '/uploads/' + profile.picture : 'https://images.unsplash.com/photo-1517486808906-6ca8b3f04846?auto=format&fit=crop&w=1200&q=80'}" alt="campus"/><div class="pill ${profile.mode}">${profile.mode === "date" ? "Date My Resmate" : profile.mode === "friend" ? "Friend My Resmate" : "Both"}</div><h1>${escapeHtml(profile.alias)}</h1><p><strong>Gender:</strong> ${profile.gender || 'Not specified'}</p><p>Status: ${verificationStatus}</p><p><strong>Bio:</strong> ${escapeHtml(profile.about)}</p><div class="tags">${profile.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><p><strong>Anonymous profile ID:</strong> ${profile._id}</p><div class="top-actions">${isOwn ? `<a class="btn" href="/discover/${profile._id}">Start Discovering</a><a class="btn btn-blue" href="/matches/${profile._id}">See Matches</a><a class="btn btn-pink" href="/notifications/${profile._id}">Notifications</a><a class="btn btn-gray" href="/edit/${profile._id}">Edit Profile</a><a class="btn btn-gray" href="/logout">Logout</a>` : (await MessageRequest.findOne({ fromId: req.session.profileId, toId: req.params.id, status: 'approved' }) ? `<a class="btn" href="/chat/${req.session.profileId}/${profile._id}">Message</a>` : '<p>To connect with this person, send them a friend request.</p>')}<form method="POST" action="/send-message-request" style="display:inline;"><input type="hidden" name="toId" value="${req.params.id}"/><button class="btn btn-blue" type="submit">👥 Friend Request</button></form></div></div>`;
    res.send(pageShell(profile.alias, html, req.session.profileId, counts));
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).send("Error loading profile");
  }
});

app.get("/edit/:id", async (req, res) => {
  try {
    if (!req.session.profileId || req.session.profileId !== req.params.id) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(req.params.id);
    if (!profile) return res.status(404).send("Profile not found");
    const html = `<div class="form" style="max-width:480px;margin:auto;"><h2>Edit Profile</h2><form method="POST" action="/edit/${profile._id}" enctype="multipart/form-data">` +
      `<label>Username</label><input name="username" value="${escapeHtml(profile.username)}" required/><p style="font-size:12px;color:#666;">Cannot be changed after signup</p>` +
      `<label>Display name (alias)</label><input name="alias" value="${escapeHtml(profile.alias)}" required/>` +
      `<label>Gender</label><select name="gender" required><option value="male" ${profile.gender==='male'?'selected':''}>Male</option><option value="female" ${profile.gender==='female'?'selected':''}>Female</option><option value="nonbinary" ${profile.gender==='nonbinary'?'selected':''}>Nonbinary</option><option value="other" ${profile.gender==='other'?'selected':''}>Other</option></select>` +
      `<label>Mode</label><select name="mode" required><option value="date" ${profile.mode==='date'?'selected':''}>Date My Resmate ❤️</option><option value="friend" ${profile.mode==='friend'?'selected':''}>Friend My Resmate 🤝</option><option value="both" ${profile.mode==='both'?'selected':''}>Both (wide socialization)</option></select>` +
      `<label>Email</label><input type="email" name="contactEmail" value="${escapeHtml(profile.contactEmail || '')}" required/><p style="font-size:12px;color:#666;">Email used for verification - cannot be changed</p</p>` +
      `<label>Phone</label><input name="contactPhone" value="${escapeHtml(profile.contactPhone || '')}"/><p style="font-size:12px;color:#666;">Backup contact - cannot be changed if already set</p>` +
      `<label>About</label><textarea name="about" required>${escapeHtml(profile.about)}</textarea>` +
      `<label>Tags comma separated</label><input name="tags" value="${escapeHtml((profile.tags || []).join(', '))}"/>` +
      `<label style="display:flex;align-items:center;gap:8px;"><span style="color:#dc2626;font-weight:bold;">TICK TO BLUR PICTURE UNTIL MATCH</span><input type="checkbox" name="blurred" ${profile.blurred ? 'checked' : ''} style="transform:scale(1.1);"/></label>` +
      `<button type="submit">Update Profile</button></form></div>`;
    res.send(pageShell('Edit Profile', html, req.session.profileId));
  } catch (err) {
    console.error('Edit profile page error:', err);
    res.status(500).send('Error loading edit form');
  }
});

app.post("/edit/:id", upload.single('picture'), async (req, res) => {
  try {
    if (!req.session.profileId || req.session.profileId !== req.params.id) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(req.params.id);
    if (!profile) return res.status(404).send("Profile not found");
    const { alias, contactEmail, contactPhone, about, tags, blurred } = req.body;
    profile.alias = alias.trim();
    profile.about = about.trim();
    profile.tags = tags ? tags.split(',').map(t => t.trim().toLowerCase()) : [];
    profile.blurred = blurred === 'on';
    if (req.file) {
      const filename = Date.now() + '.jpg';
      try {
        await sharp(req.file.buffer).resize(300, 300, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(path.join('uploads', filename));
        profile.picture = filename;
      } catch (e) {
        console.warn('Edit picture processing fallback', e.message);
      }
    }
    await profile.save();
    res.redirect(`/profile/${profile._id}`);
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).send('Error updating profile');
  }
});

app.get("/discover/:profileId", async (req, res) => {
  try {
    const currentProfile = await Profile.findById(req.params.profileId);
    if (!currentProfile) return res.status(404).send("Profile not found");
    const otherProfiles = await Profile.find({ _id: { $ne: currentProfile._id } });
    const myMatches = await Match.find({ $or: [{ fromId: currentProfile._id }, { toId: currentProfile._id }] });
    const matchedIds = new Set(myMatches.map(m => m.fromId.toString() === currentProfile._id.toString() ? m.toId.toString() : m.fromId.toString()));
    const profileCards = otherProfiles.map(p => {
      return `<div class="card"><img class="blurred" src="${p.picture ? '/uploads/' + p.picture : 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=900&q=80'}" alt="profile"/><span class="tag ${p.mode}">${p.mode === "date" ? "❤️ Date My Resmate" : p.mode === "friend" ? "🤝 Friend My Resmate" : "🌟 Both"}</span><h3>${escapeHtml(p.alias)}</h3><p>${escapeHtml(p.about)}</p><div class="tags">${p.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><div class="top-actions"><form method="POST" action="/send-message-request" style="display:inline;"><input type="hidden" name="toId" value="${p._id}"/><button class="btn btn-blue" type="submit">👥 Friend Request</button></form><form method="POST" action="/like/${currentProfile._id}/${p._id}" style="display:inline;"><button class="btn" type="submit">❤️ Like</button></form></div></div>`;
    }).join("");
    const html = `<div class="hero"><h1>Discover Profiles</h1><p>You are browsing as <strong>${escapeHtml(currentProfile.alias)}</strong></p></div><div class="grid">${profileCards || '<div class="form"><h3>No profiles yet.</h3></div>'}</div><div class="top-actions"><a class="btn btn-blue" href="/matches/${currentProfile._id}">View My Matches</a><a class="btn btn-gray" href="/profile/${currentProfile._id}">Back to Profile</a></div>`;
    res.send(pageShell("Discover Profiles", html, req.params.profileId));
  } catch (err) {
    console.error("Error in discover:", err);
    res.status(500).send("Error loading profiles");
  }
});

app.post("/like/:fromId/:toId", async (req, res) => {
  try {
    const fromId = req.params.fromId;
    const toId = req.params.toId;
    if (!fromId || !toId || fromId === toId) return res.status(400).send("Invalid profile IDs");
    const existing = await Like.findOne({ fromId, toId });
    if (!existing) {
      await new Like({ fromId, toId }).save();
      await new Notification({ userId: toId, fromId, type: 'like', message: 'Someone liked you ❤️' }).save();
    }
    res.redirect(`/discover/${fromId}`);
  } catch (err) {
    console.error("Error liking:", err);
    res.status(500).send("Error processing like");
  }
});

app.get("/matches/:profileId", async (req, res) => {
  try {
    const profileId = req.params.profileId;
    if (!req.session.profileId || req.session.profileId !== profileId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");
    const myMatches = await Match.find({ $or: [{ fromId: profileId }, { toId: profileId }] });
    const matchCards = await Promise.all(myMatches.map(async (m) => {
      const partnerId = m.fromId.toString() === profileId ? m.toId : m.fromId;
      const partner = await Profile.findById(partnerId);
      if (!partner) return '';
      return `<div class="card"><img src="${partner.picture ? '/uploads/' + partner.picture : 'https://images.unsplash.com/photo-1511988617509-a57c8a288659?auto=format&fit=crop&w=900&q=80'}" alt="match"/><h3>${escapeHtml(partner.alias)}</h3><p>${escapeHtml(partner.about)}</p><p><strong>Private anonymous chat unlocked</strong></p><a class="btn btn-pink" href="/chat/${m.roomId}/${profileId}">Open Chat</a></div>`;
    }));
    const html = `<div class="hero"><h1>My Matches</h1><p>Only mutual likes unlock anonymous private chat.</p></div><div class="grid">${matchCards.filter(Boolean).join('') || '<div class="card"><h3>No matches yet</h3><p>Keep discovering and liking profiles.</p></div>'}</div><div class="top-actions"><a class="btn" href="/discover/${profileId}">Go Discover More</a><a class="btn btn-gray" href="/profile/${profileId}">Back to Profile</a></div>`;
    res.send(pageShell("My Matches", html, req.params.profileId));
  } catch (err) {
    console.error("Error in matches:", err);
    res.status(500).send("Error loading matches");
  }
});

app.get("/chat/:fromId/:toId", async (req, res) => {
  try {
    const { fromId, toId } = req.params;
    if (!req.session.profileId || req.session.profileId !== fromId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(fromId);
    if (!profile) return res.status(404).send("Profile not found");
    // Check if message request is approved
    const messageRequest = await MessageRequest.findOne({
      $or: [
        { fromId, toId, status: 'approved' },
        { fromId: toId, toId: fromId, status: 'approved' }
      ]
    });
    if (!messageRequest) {
      return res.status(403).send(pageShell("Access Denied", `<div class="form"><h2>Chat Not Allowed</h2><p>Message request must be approved to chat.</p><a class="btn" href="/profile/${toId}">Back</a></div>`, req.session.profileId));
    }
    const roomId = `room_${[fromId, toId].sort().join("_")}`;
    const messages = await Message.find({ roomId }).sort({ createdAt: 1 });
    // Mark messages from the other user as read
    await Message.updateMany(
      { roomId, senderId: toId, read: false },
      { read: true }
    );
    const msgHTML = messages.map(m => `<div class="msg"><strong>${escapeHtml(m.senderAlias)}:</strong> ${escapeHtml(m.text)}</div>`).join("");
    const html = `<div class="chat-wrap"><h1>💬 Anonymous Private Chat</h1><p><strong>You are chatting as:</strong> ${escapeHtml(profile.alias)}</p><div id="messages">${msgHTML}</div><div class="chat-row"><input id="msgInput" placeholder="Type an anonymous message"/><button onclick="sendMsg()">Send</button></div><div class="top-actions"><a class="btn btn-gray" href="/profile/${fromId}">Back to Profile</a></div></div><script src="/socket.io/socket.io.js"><\/script><script>const socket=io();const roomId=${JSON.stringify(roomId)};const senderId=${JSON.stringify(fromId)};const senderAlias=${JSON.stringify(profile.alias)};const messagesDiv=document.getElementById('messages');const msgInput=document.getElementById('msgInput');socket.emit('joinRoom',{roomId});function appendMessage(sender,text){const div=document.createElement('div');div.className='msg';const strong=document.createElement('strong');strong.textContent=sender+': ';div.appendChild(strong);div.appendChild(document.createTextNode(text));messagesDiv.appendChild(div);messagesDiv.scrollTop=messagesDiv.scrollHeight;}function sendMsg(){const text=msgInput.value.trim();if(!text)return;socket.emit('privateMessage',{roomId,text,senderId,senderAlias});appendMessage(senderAlias,text);msgInput.value='';}msgInput.addEventListener('keydown',function(e){if(e.key==='Enter')sendMsg();});socket.on('privateMessage',function(data){appendMessage(data.senderAlias,data.text);});<\/script>`;
    res.send(pageShell("Chat", html, req.params.fromId));
  } catch (err) {
    console.error("Error in chat:", err);
    res.status(500).send("Error loading chat");
  }
});

app.get("/notifications/:profileId", async (req, res) => {
  try {
    const profileId = req.params.profileId;
    if (!req.session.profileId || req.session.profileId !== profileId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");
    const notifications = await Notification.find({ userId: profileId }).sort({ createdAt: -1 });
    const list = notifications.length > 0 ? notifications.map(n => {
      let link = '';
      if (n.type === 'messageRequest') {
        link = `/requests/${profileId}`;
      } else if (n.type === 'like' && n.fromId) {
        link = `/profile/${n.fromId}`;
      } else if (n.type === 'requestApproved' || n.type === 'requestDenied') {
        link = `/messages/${profileId}`;
      } else if (n.type === 'message') {
        link = `/messages/${profileId}`;
      }
      const content = escapeHtml(n.message);
      const time = `<small>${new Date(n.createdAt).toLocaleString()}</small>`;
      if (link) {
        return `<div class="msg"><a href="${link}" style="color:#1d4ed8;display:block;text-decoration:none;">${content}</a> ${time}</div>`;
      }
      return `<div class="msg">${content} ${time}</div>`;
    }).join('') : '<p>No notifications yet.</p>';
    const counts = await getCounts(profileId);
    const html = `<div class="hero"><h1>Notifications</h1></div><div class="chat-wrap">${list}</div><div class="top-actions"><a class="btn btn-gray" href="/profile/${profileId}">Back to Profile</a></div>`;
    res.send(pageShell("Notifications", html, req.params.profileId, counts));
  } catch (err) {
    console.error("Error in notifications:", err);
    res.status(500).send("Error loading notifications");
  }
});

app.get("/messages/:profileId", async (req, res) => {
  try {
    const profileId = req.params.profileId;
    if (!req.session.profileId || req.session.profileId !== profileId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");

    // Get pending message requests
    const pendingRequests = await MessageRequest.find({ toId: profileId, status: 'pending' }).populate('fromId', 'alias picture about gender mode');

    // Get approved conversations (message requests that are approved)
    const approvedRequests = await MessageRequest.find({
      $or: [
        { fromId: profileId, status: 'approved' },
        { toId: profileId, status: 'approved' }
      ]
    }).populate('fromId', 'alias picture about gender mode').populate('toId', 'alias picture about gender mode');

    // Get the latest message for each conversation
    const conversations = await Promise.all(approvedRequests.map(async (req) => {
      const otherUserId = req.fromId._id.toString() === profileId ? req.toId._id : req.fromId._id;
      const otherUser = req.fromId._id.toString() === profileId ? req.toId : req.fromId;
      const roomId = `room_${[profileId, otherUserId].sort().join("_")}`;
      const latestMessage = await Message.findOne({ roomId }).sort({ createdAt: -1 });
      const unreadCount = await Message.countDocuments({ roomId, senderId: otherUserId, read: false });

      return {
        otherUser,
        latestMessage,
        unreadCount,
        roomId
      };
    }));

    const requestCards = pendingRequests.map(r => `
      <div class="card" style="display:flex;align-items:center;gap:12px;">
        <img class="blurred" src="${r.fromId.picture ? '/uploads/' + r.fromId.picture : 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=100&q=80'}" alt="profile" style="width:60px;height:60px;border-radius:50%;object-fit:cover;"/>
        <div style="flex:1;">
          <h4 style="margin:0;">${escapeHtml(r.fromId.alias)}</h4>
          <p style="margin:4px 0;color:#666;font-size:14px;">${escapeHtml(r.fromId.about.substring(0, 50))}...</p>
          <small style="color:#666;">${r.fromId.gender} • ${r.fromId.mode}</small>
        </div>
        <div>
          <form method="POST" action="/approve-message-request" style="display:inline;">
            <input type="hidden" name="requestId" value="${r._id}"/>
            <button class="btn btn-blue" type="submit" name="action" value="approve" style="margin:0;">Confirm</button>
            <button class="btn btn-gray" type="submit" name="action" value="deny" style="margin:0;">Delete</button>
          </form>
        </div>
      </div>
    `).join('');

    const conversationCards = conversations.map(conv => `
      <div class="card conversation-card" onclick="window.location.href='/chat/${profileId}/${conv.otherUser._id}'" style="cursor:pointer;display:flex;align-items:center;gap:12px;">
        <img class="blurred" src="${conv.otherUser.picture ? '/uploads/' + conv.otherUser.picture : 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=100&q=80'}" alt="profile" style="width:60px;height:60px;border-radius:50%;object-fit:cover;"/>
        <div style="flex:1;">
          <h4 style="margin:0;">${escapeHtml(conv.otherUser.alias)}${conv.unreadCount > 0 ? ` <span style="background:#e53e3e;color:white;border-radius:10px;padding:2px 6px;font-size:12px;">${conv.unreadCount}</span>` : ''}</h4>
          <p style="margin:4px 0;color:#666;font-size:14px;">${conv.latestMessage ? escapeHtml(conv.latestMessage.text.substring(0, 30)) + (conv.latestMessage.text.length > 30 ? '...' : '') : 'No messages yet'}</p>
          <small style="color:#666;">${conv.otherUser.gender} • ${conv.otherUser.mode}</small>
        </div>
        <small style="color:#999;">${conv.latestMessage ? new Date(conv.latestMessage.createdAt).toLocaleDateString() : ''}</small>
      </div>
    `).join('');

    const counts = await getCounts(profileId);
    const html = `
      <div class="hero"><h1>Messages</h1></div>
      ${requestCards ? `<h2>Friend Requests</h2><div class="grid">${requestCards}</div>` : ''}
      ${conversationCards ? `<h2>Messages</h2><div class="grid">${conversationCards}</div>` : ''}
      ${!requestCards && !conversationCards ? '<div class="form"><h3>No messages or requests yet</h3><p>Start discovering profiles and sending friend requests!</p></div>' : ''}
      <div class="top-actions"><a class="btn" href="/discover/${profileId}">Find Friends</a><a class="btn btn-gray" href="/profile/${profileId}">Back to Profile</a></div>
    `;
    res.send(pageShell("Messages", html, req.params.profileId, counts));
  } catch (err) {
    console.error("Error in messages:", err);
    res.status(500).send("Error loading messages");
  }
});

app.get("/requests/:profileId", async (req, res) => {
  try {
    const profileId = req.params.profileId;
    if (!req.session.profileId || req.session.profileId !== profileId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");

    // Get pending message requests
    const pendingRequests = await MessageRequest.find({ toId: profileId, status: 'pending' }).populate('fromId', 'alias picture about gender mode').sort({ createdAt: -1 });

    const requestCards = pendingRequests.map(r => `
      <div class="card" style="display:flex;align-items:center;gap:12px;">
        <img class="blurred" src="${r.fromId.picture ? '/uploads/' + r.fromId.picture : 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=100&q=80'}" alt="profile" style="width:80px;height:80px;border-radius:50%;object-fit:cover;"/>
        <div style="flex:1;">
          <h3 style="margin:0;">${escapeHtml(r.fromId.alias)}</h3>
          <p style="margin:4px 0;color:#666;font-size:14px;"><strong>Bio:</strong> ${escapeHtml(r.fromId.about.substring(0, 80))}${r.fromId.about.length > 80 ? '...' : ''}</p>
          <small style="color:#666;"><strong>Gender:</strong> ${r.fromId.gender} | <strong>Looking for:</strong> ${r.fromId.mode}</small>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <form method="POST" action="/approve-message-request" style="display:inline;margin:0;">
            <input type="hidden" name="requestId" value="${r._id}"/>
            <button class="btn btn-blue" type="submit" name="action" value="approve">✓ Confirm</button>
          </form>
          <form method="POST" action="/approve-message-request" style="display:inline;margin:0;">
            <input type="hidden" name="requestId" value="${r._id}"/>
            <button class="btn btn-gray" type="submit" name="action" value="deny">✗ Decline</button>
          </form>
        </div>
      </div>
    `).join('');

    const counts = await getCounts(profileId);
    const html = `
      <div class="hero"><h1>Friend Requests</h1><p>Manage who can message you</p></div>
      ${pendingRequests.length > 0 ? `<div class="grid">${requestCards}</div>` : `<div class="form"><h3>No pending friend requests</h3><p>When people send you friend requests, they'll appear here. Go to <a href="/discover/${profileId}">discover</a> to send requests to others!</p></div>`}
      <div class="top-actions"><a class="btn" href="/discover/${profileId}">Discover Friends</a><a class="btn btn-gray" href="/messages/${profileId}">Back to Messages</a></div>
    `;
    res.send(pageShell("Requests", html, req.params.profileId, counts));
  } catch (err) {
    console.error("Error in requests:", err);
    res.status(500).send("Error loading requests");
  }
});

app.post("/approve-message-request", async (req, res) => {
  try {
    if (!req.session.profileId) return res.status(401).send("Please login");
    const { requestId, action } = req.body;
    const status = action === 'approve' ? 'approved' : 'denied';
    const request = await MessageRequest.findByIdAndUpdate(requestId, { status }, { new: true });
    if (request) {
      await new Notification({
        userId: request.fromId,
        fromId: req.session.profileId,
        type: status === 'approved' ? 'requestApproved' : 'requestDenied',
        message: status === 'approved' ? 'Your friend request is approved! 🎉' : 'Your friend request was denied.'
      }).save();
    }
    res.redirect(`/messages/${req.session.profileId}`);
  } catch (err) {
    console.error("Error approving message request:", err);
    res.status(500).send("Error processing request");
  }
});

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId }) => {
    socket.join(roomId);
  });
  socket.on("privateMessage", async (data) => {
    const { roomId, text, senderId, senderAlias } = data;
    if (!roomId || !text || !senderId) return;
    const message = new Message({ roomId, senderId, text, senderAlias });
    await message.save();
    io.to(roomId).emit("privateMessage", { text, senderAlias });
    // Send notification to other participant
    const parts = roomId.split('_');
    const id1 = parts[1], id2 = parts[2];
    const otherId = senderId === id1 ? id2 : id1;
    await new Notification({ userId: otherId, fromId: senderId, type: 'message', message: "New anonymous message 💬" }).save();
  });
});

server.listen(PORT, () => {
  console.log(`Resmate Match running on http://localhost:${PORT}`);
});
