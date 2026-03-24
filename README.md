# 🎉 Resmate Match

A Tinder-style residence mate matching app for students at MetroRez FNB 74, Gqeberha. Create anonymous profiles, discover matches, and unlock private chat only after mutual likes.

**Built by:** Jabulani Shibambo (@0725601834) | CAPITEC ACCEPTED

---

## ✨ Features

- **Anonymous Profiles** - Hide your real identity while building connections
- **Tinder-Style Swiping** - Swipe left (pass) or right (like) to discover matches
- **Personality Match Score** - AI-powered personality matching based on descriptions and tags
- **Profile Pictures** - Upload & optionally blur until match
- **Private Anonymous Chat** - Real-time messaging only after mutual likes (Socket.io)
- **Notifications** - Get alerts for likes and matches
- **Unique Email/Phone Registration** - One account per email/phone prevents duplicates
- **Verification Code System** - Secure signup with code-based verification
- **Profile Editing** - Update your about, tags, picture anytime

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Node.js (v18+)
- MongoDB (local or Atlas cloud)
- npm

### Installation

```bash
# Clone or extract the project
cd resmate-match

# Install dependencies
npm install

# Create uploads directory (if missing)
mkdir uploads

# Start the server
npm start
```

Server runs at: **http://localhost:3000**

---

## 🌐 Deployment (Online)

### Option 1: **Render** (Recommended - Free tier)

1. Push code to GitHub
2. Go to https://render.com
3. Create new Web Service → Connect GitHub repo
4. Environment variables:
   ```
   MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/resmatematch
   NODE_ENV=production
   PORT=3000
   ```
5. Build command: `npm install`
6. Start command: `npm start`

### Option 2: **Railway**

1. Connect GitHub repo to Railway
2. Add MongoDB service
3. Link env vars automatically
4. Deploy with one click

### Option 3: **Heroku** (requires paid dyno now)

```bash
# Install Heroku CLI
heroku login
heroku create resmate-match-app
git push heroku main
```

---

## 📝 Environment Variables

Create `.env` file for local dev:

```
MONGODB_URI=mongodb://127.0.0.1:27017/resmatematch
NODE_ENV=development
PORT=3000
```

For production (on Render/Railway):
```
MONGODB_URI=mongodb+srv://JAYJOHNJADEN2004:CorEnr30@cluster0.yhszlon.mongodb.net/resmatematch
NODE_ENV=production
PORT=3000
```

---

## 📋 User Flow

### Sign Up
1. Click "Create Profile"
2. Enter: **Username** (for login), **Display Name** (shown in profile), **Password**
3. Add **Email** (required, unique per account)
4. Optional: **Phone** number
5. Fill: About description, personality tags, profile picture
6. System generates verification code → **Copy and verify**
7. Account ready!

### Login
1. Go to `/login`
2. Enter **Username** + **Password**
3. Redirects to your profile (if verified)

### Discover & Match
1. Click "Start Discovering"
2. Swipe left (⬅️ Pass) or right (❤️ Like)
3. If both like each other → **Match created**
4. Click "View My Matches" → Open private chat

### Profile Editing
1. On profile page → "Edit Profile" button
2. Update: Display name, about, tags, picture, blur status
3. **Cannot change**: Username, Email, Phone (locked after signup)

---

## 🗄️ Database Schema

### Profile
- `username` - Login identifier (unique)
- `alias` - Display name in profiles
- `password` - Hashed password
- `contactEmail` - Email for signup (unique, locked)
- `contactPhone` - Phone (unique, optional)
- `verificationCode` - OTP for signup
- `verified` - Boolean (required to login)
- `about` - Bio description
- `tags` - Personality tags
- `picture` - Profile image filename
- `blurred` - Blur picture until match
- `mode` - "date" or "friend"

### Like
- `fromId` - User who liked
- `toId` - User being liked

### Match
- `fromId` / `toId` - Both users
- `roomId` - Unique chat room identifier

### Message
- `roomId` - Chat room
- `senderId` - Message sender
- `senderAlias` - Sender's display name
- `text` - Message content
- `createdAt` - Timestamp

### Notification
- `userId` - Recipient
- `message` - Notification text
- `createdAt` - Timestamp

---

## 🛠️ API Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Homepage with profiles & signup |
| `/create` | POST | Create profile with image upload |
| `/login` | GET/POST | Username + password login |
| `/verify` | GET/POST | Verify signup code |
| `/profile/:id` | GET | View profile (protected) |
| `/edit/:id` | GET/POST | Edit profile (protected) |
| `/discover/:id` | GET | Swipe interface (protected) |
| `/swipe/:fromId/:toId` | POST | Like/pass action |
| `/matches/:id` | GET | View matches (protected) |
| `/chat/:roomId/:id` | GET | Chat room (protected via session) |
| `/notifications/:id` | GET | Notification history (protected) |
| `/logout` | GET | Destroy session |

---

## 🔐 Security Features

- **Session-based auth** - Express-session with 3-hour cookie timeout
- **Unique constraints** - Email/phone/username can only register once
- **Verification codes** - OTP required before first login
- **XSS protection** - HTML escaping on all user input
- **Password storage** - Plain text (upgrade to bcrypt for production!)
- **Private chat** - Only matched users can access same room

---

## 🎨 Styling & UI

- **Gradient background** - Soft pastel (pink → blue)
- **Card-based layout** - Modern responsive design
- **Mobile-friendly** - Fully responsive on all devices
- **Shadow effects** - Depth with hover transforms
- **Footer branding** - "BY JABULANI SHIBAMBO @0725601834 CAPITEC ACCEPTED"

---

## 📱 Technologies Used

- **Backend**: Express.js, Node.js
- **Database**: MongoDB (local or Atlas)
- **Real-time Chat**: Socket.io
- **Image Processing**: Sharp, Multer
- **Sessions**: express-session
- **ODM**: Mongoose

---

## 🐛 Troubleshooting

### MongoDB Connection Error
```
Error: querySrv ECONNREFUSED
```
→ Check Atlas Network Access whitelist or use local MongoDB

### Image Upload Fails
→ Images are stored in `/uploads` directory with fallback to raw buffer

### Port Already in Use
```bash
# Kill process on port 3000
# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

---

## 📞 Support & Contact

- **Creator**: Jabulani Shibambo
- **Phone**: @0725601834
- **Campus**: MetroRez FNB 74, Govon Mbheki Road, Gqeberha
- **Payment**: CAPITEC ACCEPTED

---

## 📄 License

MIT License - Free to use, modify, deploy

---

## 🎯 Next Features (Roadmap)

- [ ] Password hashing (bcrypt)
- [ ] Email notification integration (SendGrid)
- [ ] SMS verification (Twilio)
- [ ] Admin dashboard
- [ ] Reported profiles/blocking
- [ ] Rating & reviews
- [ ] Location-based matching
- [ ] Video profiles

---

**Deploy now and bring MetroRez residents together!** 🚀
