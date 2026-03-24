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
  mode: String,
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
});

const notificationSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
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

function pageShell(title, body, profileId = null) {
  const nav = profileId ? `<nav style="background:white;border-radius:12px;padding:12px;margin-bottom:24px;box-shadow:0 4px 12px rgba(0,0,0,.1);"><a class="btn" href="/">Home</a><a class="btn" href="/discover/${profileId}">Discover</a><a class="btn" href="/matches/${profileId}">Matches</a><a class="btn" href="/profile/${profileId}">My Profile</a><a class="btn" href="/newsfeed">News Feed</a></nav>` : `<nav style="background:white;border-radius:12px;padding:12px;margin-bottom:24px;box-shadow:0 4px 12px rgba(0,0,0,.1);"><a class="btn" href="/">Home</a><a class="btn" href="/newsfeed">News Feed</a></nav>`;
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1.0"/><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(135deg,#ff9a9e,#fad0c4,#fbc2eb,#a6c1ee);min-height:100vh;padding:24px;color:#111}a{color:#093b70;text-decoration:none}a:hover{text-decoration:underline}.container{max-width:1150px;margin:auto}.hero{background:rgba(255,255,255,.3);color:#1f2937;border-radius:26px;padding:28px;box-shadow:0 12px 30px rgba(0,0,0,.2);backdrop-filter:blur(8px);margin-bottom:24px}.hero h1{margin:0 0 10px;font-size:2.2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.card,.form,.feature,.chat-wrap{background:white;border-radius:22px;padding:18px;box-shadow:0 16px 30px rgba(15,23,42,.15)}.feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;margin:22px 0}.card{position:relative;border:1px solid #e5e7eb}.card img,.profile-cover{width:100%;border-radius:16px;margin-bottom:12px;display:block}.tag,.pill{display:inline-block;padding:6px 12px;border-radius:999px;color:white;font-size:12px;font-weight:bold}.tag{position:absolute;top:16px;right:16px}.date{background:#ef4444}.friend{background:#0ea5e9}input,textarea,select{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;margin-top:8px;margin-bottom:16px;font-size:15px;outline:none;transition:all .2s ease}input:focus,textarea:focus,select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.2)}textarea{min-height:140px;resize:vertical}.btn,button{background:#1f2937;color:white;border:none;border-radius:12px;padding:12px 16px;text-decoration:none;cursor:pointer;display:inline-block;margin-right:8px;margin-top:8px;transition:transform .1s ease,box-shadow .1s ease}.btn:hover,button:hover{transform:translateY(-1px);box-shadow:0 8px 18px rgba(15,23,42,.2)}.btn-pink{background:#ec4899}.btn-blue{background:#0284c7}.btn-gray{background:#6b7280}.top-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}#messages{height:350px;overflow:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:14px;margin-bottom:14px}.msg{margin-bottom:10px;padding:10px 12px;background:#fff;border-radius:12px;border:1px solid #e8f0fe}.chat-row{display:flex;gap:10px}.chat-row input{margin:0;flex:1}@media (max-width:700px){body{padding:14px}.hero h1{font-size:1.7rem}.chat-row{flex-direction:column}}.blurred{filter:blur(5px)}.tags{margin:10px 0}.tags .pill{margin-right:5px}.footer-custom{margin-top:24px;padding:10px;color:#1f2937;text-align:center;font-weight:700}</style></head><body><div class="container">${nav}${body}</div><div class="footer-custom">BY JABULANI SHIBAMBO @0725601834 CAPITEC ACCEPTED</div></body></html>`;
}

app.get("/", async (req, res) => {
  try {
    if (!isDbConnected()) {
      const hint = dbErrorHint();
      const errMsg = `<div style="padding:24px; font-family:Arial, Helvetica, sans-serif; background:#fff;color:#b91c1c;border:2px solid #fca5a5;border-radius:12px;"><h2>Error loading profiles</h2><p>${escapeHtml(hint)}</p><p>Current URI: ${escapeHtml(mongoURI)}</p><p>${escapeHtml(mongoMessage || 'Check MONGODB_URI and Atlas IP whitelist.')}</p></div>`;
      return res.status(500).send(pageShell("Error", errMsg));
    }

    const profiles = await Profile.find();
    const profileCards = profiles.map(p => `<div class="card"><img class="${p.blurred ? 'blurred' : ''}" src="${p.picture ? '/uploads/' + p.picture : 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=900&q=80'}" alt="profile"/><span class="tag ${p.mode}">${p.mode === "date" ? "❤️ Date My Resmate" : "🤝 Friend My Resmate"}</span><h3>${escapeHtml(p.alias)}</h3><p>${escapeHtml(p.about)}</p><div class="tags">${p.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><div class="top-actions"><a class="btn" href="/profile/${p._id}">Open Profile</a></div></div>`).join("");
    const html = `<div class="hero"><h1>🎉 Resmate Match</h1><p>Create a fun anonymous profile, choose your vibe, browse students, swipe to connect, and unlock private anonymous chat only after a mutual like.</p><p>📍 Campus: FNB 74 Govon Mbheki Metrorez, Gqeberha. For best results, use a campus photo if available.</p><p><a class="btn btn-blue" href="/login">Login with Username + Password</a></p></div><div class="feature-grid"><div class="feature"><h3>❤️ Date My Resmate</h3><p>Descriptions are rewritten in a romantic way.</p></div><div class="feature"><h3>🤝 Friend My Resmate</h3><p>Descriptions are rewritten in a friendly way.</p></div><div class="feature"><h3>💬 Anonymous Chat</h3><p>Private chat opens only after both people like each other.</p></div><div class="feature"><h3>🎯 Match Score</h3><p>Profiles get simple personality-based suggestions.</p></div></div><div class="form"><h2>Create Anonymous Profile</h2><form method="POST" action="/create" enctype="multipart/form-data"><label>Choose option</label><select name="mode" required><option value="date">Date My Resmate ❤️</option><option value="friend">Friend My Resmate 🤝</option></select><label>Username (for login)</label><input name="username" placeholder="Example: SilentHeart or ChillBuddy" required/><label>Display name (alias)</label><input name="alias" placeholder="Your anonymous name shown in profiles" required/><label>Password (keep this safe)</label><input type="password" name="password" placeholder="Enter password" required/><label>Email (verification code will be sent here)</label><input type="email" name="contactEmail" placeholder="your.email@example.com" required/><label>Phone (optional backup for verification)</label><input name="contactPhone" placeholder="e.g. +27825601834"/><label>Describe yourself</label><textarea name="about" placeholder="Example: I enjoy music, laughing, late-night talks, studying together..." required></textarea><label>Personality tags (comma separated)</label><input name="tags" placeholder="introvert, gym lover, night owl, romantic, funny"/><label>Profile picture</label><input type="file" name="picture" accept="image/*"/><label style="display:flex;align-items:center;gap:8px;"><span style="color:#dc2626;font-weight:bold;">TICK TO BLUR PICTURE UNTIL MATCH</span><input type="checkbox" name="blurred" style="transform:scale(1.1);"/></label><button type="submit">Create Profile</button></form></div><h2 style="color:white;">🌈 Community Profiles</h2><div class="grid">${profileCards || '<div class="form"><p>No profiles yet. Create the first one.</p></div>'}</div><footer style="margin-top:20px;color:white;text-align:center;">BY JABULANI SHIBAMBO @0725601834 CAPITEC ACCEPTED</footer>`;
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

app.post("/verify", async (req, res) => {
  try {
    const { profileId, code } = req.body;
    if (!profileId || !code) return res.status(400).send("Profile ID and code required");
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");
    if (profile.verificationCode !== code) return res.status(400).send("Invalid code");
    profile.verified = true;
    profile.verificationCode = null;
    await profile.save();
    req.session.profileId = profile._id.toString();
    res.redirect(`/profile/${profile._id}`);
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).send("Verification failed");
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
      mode,
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
      // Check for mutual match
      const match = await Match.findOne({
        $or: [
          { fromId: req.session.profileId, toId: req.params.id },
          { fromId: req.params.id, toId: req.session.profileId }
        ]
      });
      canView = !!match;
    }
    if (!canView) {
      return res.status(403).send(pageShell("Access Denied", `<div class="form"><h2>Profile Private</h2><p>You can only view profiles after a mutual like.</p><a class="btn" href="/login">Login</a></div>`, req.session.profileId));
    }
    const verificationStatus = profile.verified ? '<span style="color:green;font-weight:bold;">Verified</span>' : '<span style="color:red;font-weight:bold;">Not verified - <a href="/verify">Verify now</a></span>';
    const html = `<div class="card" style="max-width:700px;margin:auto;"><img class="profile-cover" src="${profile.picture ? '/uploads/' + profile.picture : 'https://images.unsplash.com/photo-1517486808906-6ca8b3f04846?auto=format&fit=crop&w=1200&q=80'}" alt="campus"/><div class="pill ${profile.mode}">${profile.mode === "date" ? "Date My Resmate" : "Friend My Resmate"}</div><h1>${escapeHtml(profile.alias)}</h1><p>Status: ${verificationStatus}</p><p>${escapeHtml(profile.about)}</p><div class="tags">${profile.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><p><strong>Anonymous profile ID:</strong> ${profile._id}</p><div class="top-actions">${isOwn ? `<a class="btn" href="/discover/${profile._id}">Start Discovering</a><a class="btn btn-blue" href="/matches/${profile._id}">See Matches</a><a class="btn btn-pink" href="/notifications/${profile._id}">Notifications</a><a class="btn btn-gray" href="/edit/${profile._id}">Edit Profile</a><a class="btn btn-gray" href="/logout">Logout</a>` : `<a class="btn" href="/chat/${req.session.profileId}/${profile._id}">Chat</a>`}</div></div>`;
    res.send(pageShell(profile.alias, html, req.session.profileId));
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
      `<label>Email</label><input type="email" name="contactEmail" value="${escapeHtml(profile.contactEmail || '')}" required/><p style="font-size:12px;color:#666;">Email used for verification - cannot be changed</p>` +
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
    const otherProfiles = await Profile.find({ _id: { $ne: currentProfile._id }, mode: currentProfile.mode });
    const myMatches = await Match.find({ $or: [{ fromId: currentProfile._id }, { toId: currentProfile._id }] });
    const matchedIds = new Set(myMatches.map(m => m.fromId.toString() === currentProfile._id.toString() ? m.toId.toString() : m.fromId.toString()));
    const profileCards = otherProfiles.map(p => {
      const isMatched = matchedIds.has(p._id.toString());
      return `<div class="card"><img class="${isMatched ? '' : 'blurred'}" src="${p.picture ? '/uploads/' + p.picture : 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=900&q=80'}" alt="profile"/><span class="tag ${p.mode}">${p.mode === "date" ? "❤️ Date My Resmate" : "🤝 Friend My Resmate"}</span><h3>${escapeHtml(p.alias)}</h3><p>${escapeHtml(p.about)}</p><p><strong>Match score:</strong> ${calculateMatchScore(currentProfile, p)}%</p><div class="tags">${p.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div><div class="top-actions"><form method="POST" action="/swipe/${currentProfile._id}/${p._id}" style="display:inline;"><input type="hidden" name="action" value="pass"/><button class="btn btn-gray" type="submit">⬅️ Pass</button></form><form method="POST" action="/swipe/${currentProfile._id}/${p._id}" style="display:inline;"><input type="hidden" name="action" value="like"/><button class="btn btn-pink" type="submit">❤️ Like</button></form></div></div>`;
    }).join("");
    const html = `<div class="hero"><h1>Discover Profiles</h1><p>You are browsing as <strong>${escapeHtml(currentProfile.alias)}</strong></p></div><div class="grid">${profileCards || '<div class="form"><h3>No profiles yet.</h3></div>'}</div><div class="top-actions"><a class="btn btn-blue" href="/matches/${currentProfile._id}">View My Matches</a><a class="btn btn-gray" href="/profile/${currentProfile._id}">Back to Profile</a></div>`;
    res.send(pageShell("Discover Profiles", html, req.params.profileId));
  } catch (err) {
    console.error("Error in discover:", err);
    res.status(500).send("Error loading profiles");
  }
});

app.post("/swipe/:fromId/:toId", async (req, res) => {
  try {
    const fromId = req.params.fromId;
    const toId = req.params.toId;
    const action = req.body.action;
    if (!fromId || !toId || fromId === toId) return res.status(400).send("Invalid profile IDs");
    if (action === "like") {
      const existing = await Like.findOne({ fromId, toId });
      if (!existing) {
        await new Like({ fromId, toId }).save();
        await new Notification({ userId: toId, message: "Someone liked you 👀" }).save();
      }
      const mutual = await Like.findOne({ fromId: toId, toId: fromId });
      if (mutual) {
        const roomId = `room_${[fromId, toId].sort().join("_")}`;
        const existingMatch = await Match.findOne({ roomId });
        if (!existingMatch) {
          await new Match({ fromId, toId, roomId }).save();
          await new Notification({ userId: fromId, message: "New match ❤️" }).save();
          await new Notification({ userId: toId, message: "New match ❤️" }).save();
        }
      }
    }
    res.redirect(`/discover/${fromId}`);
  } catch (err) {
    console.error("Error in swipe:", err);
    res.status(500).send("Error processing swipe");
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

app.get("/chat/:roomId/:profileId", async (req, res) => {
  try {
    const { roomId, profileId } = req.params;
    if (!req.session.profileId || req.session.profileId !== profileId) {
      return res.redirect('/login');
    }
    const profile = await Profile.findById(profileId);
    if (!profile) return res.status(404).send("Profile not found");
    const messages = await Message.find({ roomId }).sort({ createdAt: 1 });
    const msgHTML = messages.map(m => `<div class="msg"><strong>${escapeHtml(m.senderAlias)}:</strong> ${escapeHtml(m.text)}</div>`).join("");
    const html = `<div class="chat-wrap"><h1>💬 Anonymous Private Chat</h1><p><strong>You are chatting as:</strong> ${escapeHtml(profile.alias)}</p><div id="messages">${msgHTML}</div><div class="chat-row"><input id="msgInput" placeholder="Type an anonymous message"/><button onclick="sendMsg()">Send</button></div><div class="top-actions"><a class="btn btn-gray" href="/matches/${profileId}">Back to Matches</a></div></div><script src="/socket.io/socket.io.js"><\/script><script>const socket=io();const roomId=${JSON.stringify(roomId)};const senderId=${JSON.stringify(profileId)};const senderAlias=${JSON.stringify(profile.alias)};const messagesDiv=document.getElementById('messages');const msgInput=document.getElementById('msgInput');socket.emit('joinRoom',{roomId});function appendMessage(sender,text){const div=document.createElement('div');div.className='msg';const strong=document.createElement('strong');strong.textContent=sender+': ';div.appendChild(strong);div.appendChild(document.createTextNode(text));messagesDiv.appendChild(div);messagesDiv.scrollTop=messagesDiv.scrollHeight;}function sendMsg(){const text=msgInput.value.trim();if(!text)return;socket.emit('privateMessage',{roomId,text,senderId,senderAlias});appendMessage(senderAlias,text);msgInput.value='';}msgInput.addEventListener('keydown',function(e){if(e.key==='Enter')sendMsg();});socket.on('privateMessage',function(data){appendMessage(data.senderAlias,data.text);});<\/script>`;
    res.send(pageShell("Chat", html, req.params.profileId));
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
    const list = notifications.length > 0 ? notifications.map(n => `<div class="msg">${escapeHtml(n.message)} <small>${n.createdAt.toLocaleString()}</small></div>`).join('') : '<p>No notifications yet.</p>';
    const html = `<div class="hero"><h1>Notifications</h1></div><div class="chat-wrap">${list}</div><div class="top-actions"><a class="btn btn-gray" href="/profile/${profileId}">Back to Profile</a></div>`;
    res.send(pageShell("Notifications", html, req.params.profileId));
  } catch (err) {
    console.error("Error in notifications:", err);
    res.status(500).send("Error loading notifications");
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
    const match = await Match.findOne({ roomId });
    if (match) {
      const otherId = match.fromId.toString() === senderId ? match.toId : match.fromId;
      await new Notification({ userId: otherId, message: "New anonymous message 💬" }).save();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Resmate Match running on http://localhost:${PORT}`);
});
