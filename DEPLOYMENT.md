# 🌐 DEPLOYMENT GUIDE - Go Online!

## Step-by-Step: Deploy to Render.com (FREE TIER)

### 1. Push Code to GitHub

```bash
# In your project folder
git init
git add .
git commit -m "Initial commit - Resmate Match app"

# Create repo on GitHub.com
# Then push:
git remote add origin https://github.com/YOUR_USERNAME/resmate-match.git
git branch -M main
git push -u origin main
```

### 2. Create Render Account

- Go to https://render.com
- Sign up with GitHub
- Authorize GitHub access

### 3. Deploy Web Service

1. Click **"New +"** → Select **"Web Service"**
2. Connect GitHub repository → Select `resmate-match`
3. Fill form:
   - **Name**: `resmate-match` (or your custom name)
   - **Environment**: `Node`
   - **Region**: `Frankfurt` (closest to SA)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

4. **Environment Variables** → Add:
   ```
   MONGODB_URI = mongodb+srv://JAYJOHNJADEN2004:CorEnr30@cluster0.yhszlon.mongodb.net/resmatematch?appName=Cluster0&retryWrites=true&w=majority
   NODE_ENV = production
   ```

5. Click **"Create Web Service"**

### 4. Wait for Deployment (2-5 minutes)

Live URL: `https://resmate-match-XXXXX.onrender.com`

---

## Step-by-Step: Deploy to Railway.app (ALSO FREE)

### 1. Push to GitHub (same as above)

### 2. Create Railway Account

- Go to https://railway.app
- Sign up with GitHub
- Deploy in one click

### 3. Create New Project

1. Click **"New Project"** → **"Deploy from GitHub repo"**
2. Select `resmate-match`
3. Wait for auto-detection

### 4. Add MongoDB Service

1. Click **"Add"** → Search **"MongoDB"**
2. Select **MongoDB** → Click **"Provision"**
3. Environment vars auto-populate

### 5. Configure Environment

- Add env var: `NODE_ENV = production`
- Railway auto-creates: `MONGODB_URI`

### 6. View Live App

- **Settings** → **Domains** → Copy domain
- Live: `https://your-app.up.railway.app`

---

## Alternative: Heroku (Paid - $5+/month)

```bash
# Install Heroku CLI: https://devcenter.heroku.com/articles/heroku-cli

heroku login
heroku create resmate-match-gqeberha
heroku config:set MONGODB_URI="your_atlas_string"
heroku config:set NODE_ENV=production

git push heroku main

# View logs:
heroku logs --tail

# Open live app:
heroku open
```

---

## Post-Deployment Checklist

- [ ] Visit live URL and test signup
- [ ] Upload a profile picture → Verify it shows
- [ ] Create test account with email/phone
- [ ] Verify code system works
- [ ] Test swipe/match/chat features
- [ ] Check if links work (edit, logout, etc)

---

## Troubleshooting Deployment

### Build fails with "ENOENT: no such file or directory"
→ Make sure all files are committed to GitHub:
```bash
git add .
git commit -m "Fix: include all files"
git push
```

### App crashes - Check logs
```bash
# On Render: View "Logs" tab
# On Railway: View "Logs" 
# Look for: MongoDB connection errors, module not found
```

### Pictures not showing
→ Render/Railway uses ephemeral storage. For production:
- Use AWS S3 or Cloudinary for image storage (paid)
- Or accept that images reset on redeploy

### MongoDB connection timeout
→ Check MongoDB Atlas Network Access:
1. Go to Atlas → Cluster → Security → Network Access
2. Add `0.0.0.0/0` (allow all IPs) or your server's IP

---

## Your Live App URL

Once deployed, share with MetroRez:
- **Production URL**: `https://resmate-match-XXXX.onrender.com`
- **Direct friends to**: Sign up on homepage
- **Tell them**: Username + email required, verification code sent

---

## Quick Summary

| Platform | Free Tier | Setup Time | Recommendation |
|----------|-----------|-----------|-----------------|
| **Render** | Yes (512MB RAM) | 5 min | ✅ **Best for this app** |
| **Railway** | Yes (10GB/mo) | 5 min | ✅ **Also excellent** |
| **Heroku** | No ($5+) | 10 min | Not recommended (paid) |

---

**Ready to go live? Choose Render or Railway and deploy now!** 🚀
