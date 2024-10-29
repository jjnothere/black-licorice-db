import express from 'express';
import axios from 'axios';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import cron from 'node-cron';
import dotenv from 'dotenv';
import passport from 'passport';
import { Strategy as LinkedInStrategy } from 'passport-linkedin-oauth2';
import session from 'express-session';

dotenv.config(); // Load environment variables

const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS

// Configure session
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

// Initialize Passport for LinkedIn OAuth
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// MongoDB client setup
const url = 'mongodb+srv://jjnothere:GREATpoop^6^@black-licorice-cluster.5hb9ank.mongodb.net/?retryWrites=true&w=majority&appName=black-licorice-cluster';
const client = new MongoClient(url);

// LinkedIn Strategy for OAuth 2.0
passport.use(new LinkedInStrategy({
  clientID: process.env.LINKEDIN_CLIENT_ID,
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
  callbackURL: "http://localhost:8000/auth/linkedin/callback",
  scope: ['r_ads_reporting', 'r_ads', 'rw_ads', 'r_basicprofile'],
}, (accessToken, refreshToken, profile, done) => {
  // Pass both the profile and accessToken to be used in the callback
  return done(null, { profile, accessToken });
}));

// LinkedIn authentication route
app.get('/auth/linkedin', (req, res, next) => {
  next();
}, passport.authenticate('linkedin'));

// LinkedIn callback route
// LinkedIn callback route
app.get('/auth/linkedin/callback',
  passport.authenticate('linkedin', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      const { accessToken, profile } = req.user;

      // Check if the accessToken is available
      if (!accessToken) {
        console.error('Error: Access token not found');
        return res.status(400).json({ error: 'Access token not found' });
      }

      // Extract necessary details from LinkedIn profile
      const linkedinId = profile.id;  // Using linkedinId instead of email
      const firstName = profile.name.givenName;
      const lastName = profile.name.familyName;

      await client.connect();
      const db = client.db('black-licorice');
      const usersCollection = db.collection('users');

      // Call LinkedIn API to fetch the user's ad accounts
      const adAccountsUrl = `https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser`;
      const adAccountsResponse = await axios.get(adAccountsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      });

      // Map ad accounts to include the initialized campaigns array
      const adAccounts = adAccountsResponse.data.elements.map(account => ({
        accountId: account.account.split(':').pop(), // Extract only the accountId part
        role: account.role,
        campaigns: [] // Initialize an empty array for campaigns
      }));

      // Check if user already exists in the database
      const existingUser = await usersCollection.findOne({ linkedinId });

      let user;

      if (existingUser) {
        // Update the user's access token and ad accounts
        await usersCollection.updateOne(
          { linkedinId },
          {
            $set: {
              accessToken: accessToken,
              firstName: firstName,
              lastName: lastName,
              lastLogin: new Date(),
              adAccounts: adAccounts, // Save ad account info with initialized campaigns
            },
          }
        );
        user = existingUser;
      } else {
        // If user does not exist, create a new user
        const newUser = {
          linkedinId: linkedinId,
          accessToken: accessToken,
          firstName: firstName,
          lastName: lastName,
          userId: uuidv4(),  // Generate a unique userId
          createdAt: new Date(),
          adAccounts: adAccounts, // Save ad account info with initialized campaigns
        };
        await usersCollection.insertOne(newUser);
        user = newUser;
      }

      // Generate a JWT token with linkedinId and userId (no email)
      const jwtAccessToken = jwt.sign(
        { linkedinId: user.linkedinId, userId: user.userId },
        process.env.LINKEDIN_CLIENT_SECRET,
        { expiresIn: '2h' }
      );
      const refreshToken = jwt.sign(
        { linkedinId: user.linkedinId, userId: user.userId },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      );
      await usersCollection.updateOne({ linkedinId }, { $set: { refreshToken } });

      // Redirect to the frontend with the access token in the query
      res.redirect(`http://localhost:5173/history?token=${jwtAccessToken}&refreshToken=${refreshToken}`);
    } catch (error) {
      console.error('Error fetching ad accounts or saving user to the database:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }
);


// Token verification middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; // Extract Bearer token
  if (!token) return res.status(401).json({ message: 'Access Denied' });

  try {
    const verified = jwt.verify(token, process.env.LINKEDIN_CLIENT_SECRET);
    req.user = verified; // Attach user info to the request
    next(); // Proceed if token is valid
  } catch (error) {
    return res.status(403).json({ message: 'Invalid Token' });
  }
};

// Logout route
app.post('/logout', authenticateToken, async (req, res) => {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    await usersCollection.updateOne({ linkedinId: req.user.linkedinId }, { $unset: { refreshToken: '' } });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Refresh token route
app.post('/refresh-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(403).send('Refresh token required.');

  try {
    const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    const newAccessToken = jwt.sign(
      { linkedinId: decoded.linkedinId, userId: decoded.userId },
      process.env.LINKEDIN_CLIENT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ accessToken: newAccessToken });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(403).json({ message: 'Invalid refresh token' });
  }
});

// Test route
app.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'You have access to protected route' });
});

// const LINKEDIN_CLIENT_SECRET = '10e9b23966ddb67730a76de7cbaa4f58b06f18a8d11d181888d4ee5b3412d06b';

// test

// const token = 'AQXwqFy0cEEA9Di606cATO0NJ56KzGr75cZi-lfwLiL7rRYCqDitp-P2js3nX_tiWXY5vd2Yr8qJrYp1jQCwOa-j0hws_RGY7M5jyANYtR0IxrrGZlz8QhrZFi7PnQLr7qRgwiTru7Utz_jNNsDfaYzNW32lcbxskoGUKG6QeLclt8chdbiCuQAYYwFvgokm8Wx3-UhurZjgQrfHdIghBpQogNG650qG5r7WqQ-ROstfqOZYwVBxOX1fiD_hpLB3RqUwzjNRrcLs2gF_Vs0_WtY66VrD3VsTTUwcjKZy9BlDYwMLP68YuBp-G0A2WGxiHndV7VmNumDI5QRQmE4DlKqoeLfG0w';
// rf AQUcMDVwnfzMXs6_oRe67OxcrOhYrMrVco2vHh7mybvvWbxJ8LbWdN9evnnm0a5_DLlimngrbLWXjGoxlSPlx0AXsNhPbmMEztKUtgiBK3hp8qGNkZYeyY7ZlV0ljOmHZNxr-r8BIkOg5ARvmuUsUerWMkMzEFSTWtmvQnKf4f6YCn7vD7A1QmkXHr5ZjsvS7sCybreVSNAwBiCHC2BfZnCPWraIANlFqrFiNpnE5gKY7g73M-0CD9PMLLo5RR4SeBrgbeyb8OwjUESB7pMmlgNxrpOdzFG9K4dtWs_fGg46pZoAx_XSkPKwhYBjHWp4DG6Fy-5Grq0ccUR1YAf8Yyf0zkrhFw

// Initialize Express app



// Enable CORS for development
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: 'http://localhost:5173' }));
}
// Schedule the checkForChanges function to run every day at 2:15 PM
cron.schedule('0 23 * * *', async () => {
  try {
    await checkForChangesForAllUsers();
  } catch (error) {
    console.error('Error running checkForChanges task:', error);
  }
});

async function checkForChangesForAllUsers() {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    const users = await usersCollection.find({}).toArray();

    for (const user of users) {
      await checkForChanges(user.userId, user.accountId, db);
    }
  } catch (error) {
    console.error('Error in checkForChangesForAllUsers:', error);
  }
}

async function checkForChanges(userId, userAdAccountID, db) {
  try {
    const differences = [];
    const currentCampaigns = await fetchCurrentCampaigns(db, userId, userAdAccountID); // Fetch campaigns for the specific ad account
    const linkedInCampaigns = await fetchLinkedInCampaigns(userAdAccountID); // Fetch campaigns from LinkedIn API

    const newDifferences = [];

    linkedInCampaigns.forEach(campaign2 => {
      const campaign1 = currentCampaigns.find(c => c.id === campaign2.id);
      if (campaign1) {
        const changes = findDifferences(campaign1, campaign2);
        if (Object.keys(changes).length > 0) {
          const changesString = Object.entries(changes)
            .map(([key, value]) => `${key}: <span class="old-value">${JSON.stringify(value.old)}</span> => <span class="new-value">${JSON.stringify(value.new)}</span>`)
            .join('<br>');
          newDifferences.push({
            campaign: campaign2.name,
            date: new Date().toLocaleDateString(),
            changes: changesString,
            notes: campaign2.notes || [],
            addingNote: false,
            _id: campaign1._id // Ensure we have the correct MongoDB ID
          });
        }
      } else {
        newDifferences.push({
          campaign: campaign2.name,
          date: new Date().toLocaleDateString(),
          changes: `New campaign added: <span class="new-campaign">${campaign2.name}</span>`,
          notes: campaign2.notes || [],
          addingNote: false,
          _id: campaign2._id // Include _id if available
        });
      }
    });

    const uniqueDifferences = newDifferences.filter(newDiff =>
      !differences.some(existingDiff =>
        existingDiff.campaign === newDiff.campaign &&
        existingDiff.date === newDiff.date &&
        existingDiff.changes === newDiff.changes
      )
    );

    await saveCampaigns(db, linkedInCampaigns, userId, props.selectedAdAccountId);
    // After finding differences between LinkedIn and stored campaigns
    await saveChanges(db, uniqueDifferences, userId, selectedAdAccountId); // Calls saveChanges
  } catch (error) {
    console.error(`Error in checkForChanges for user ${userId} and ad account ${userAdAccountID}:`, error);
  }
}

async function fetchCurrentCampaigns(db, userId, accountId) {
  const userCampaigns = await db.collection('adCampaigns').findOne({ userId: userId });
  return userCampaigns?.adCampaigns?.[accountId]?.campaigns || [];
}

async function fetchLinkedInCampaigns(userAdAccountID) {
  const response = await axios.get(`https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-RestLi-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202406',
    },
  });
  return response.data.elements || [];
}

async function saveCampaigns(db, campaigns, userId) {
  const collection = db.collection('campaigns');
  const existingDoc = await collection.findOne({ userId: userId });

  if (existingDoc) {
    await collection.updateOne({ userId: userId }, { $set: { elements: campaigns } });
  } else {
    await collection.insertOne({ userId: userId, elements: campaigns });
  }
}

const findDifferences = (obj1, obj2, prefix = '') => {
  const diffs = {};
  for (const key in obj1) {
    if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      const nestedDiffs = findDifferences(obj1[key], obj2[key], `${prefix}${key}.`);
      Object.assign(diffs, nestedDiffs);
    } else if (JSON.stringify(obj1[key]) !== JSON.stringify(obj2[key])) {
      diffs[`${prefix}${key}`] = { old: obj1[key], new: obj2[key] };
    }
  }
  return diffs;
};


async function saveChanges(db, changes, userId, adAccountId) {
  if (!adAccountId) {
    console.error("Error: adAccountId is undefined.");
    return; // Exit if adAccountId is not provided
  }

  const collection = db.collection('changes');
  const changesWithIds = changes.map(change => ({
    ...change,
    _id: change._id ? new ObjectId(change._id) : new ObjectId()
  }));

  const existingUserChanges = await collection.findOne({ userId });

  if (existingUserChanges) {
    const existingAdAccountChanges = existingUserChanges.changes[adAccountId] || [];

    const uniqueChanges = changesWithIds.filter(newChange =>
      !existingAdAccountChanges.some(existingChange =>
        existingChange._id.equals(newChange._id) ||
        (existingChange.campaign === newChange.campaign &&
          existingChange.date === newChange.date &&
          existingChange.changes === newChange.changes)
      )
    );

    if (uniqueChanges.length > 0) {
      await collection.updateOne(
        { userId },
        { $push: { [`changes.${adAccountId}`]: { $each: uniqueChanges } } }
      );
    }
  } else {
    await collection.insertOne({
      userId,
      changes: { [adAccountId]: changesWithIds }
    });
  }
}

// Route to get the user's ad accounts
app.get('/get-user-ad-accounts', authenticateToken, async (req, res) => {
  try {
    // Fetch the user based on the authenticated LinkedIn ID
    const user = await client.db('black-licorice')
      .collection('users')
      .findOne({ linkedinId: req.user.linkedinId });

    if (!user || !user.adAccounts) {
      // If the user or ad accounts are not found, return a 404 error
      return res.status(404).json({ error: 'User or ad accounts not found' });
    }

    // Return the ad accounts to the client
    res.json({ adAccounts: user.adAccounts });
  } catch (error) {
    console.error('Error fetching user ad accounts:', error);
    res.status(500).send('Error fetching user ad accounts');
  }
});

// Serve static files from the Vue app's build directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../public')));

app.get('/hello', async (req, res) => {
  await client.connect();
  const db = client.db('black-licorice');
  const items = await db.collection('items').find({}).toArray();
  res.send(items);
});

// async function authenticateToken(req, res, next) {
//   const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];

//   if (!token) return res.status(401).json({ message: 'Access Denied' });

//   try {
//     const verified = jwt.verify(token, LINKEDIN_CLIENT_SECRET);
//     req.user = verified;

//     await client.connect();
//     const db = client.db('black-licorice');
//     const user = await db.collection('users').findOne({ email: verified.email });

//     if (!user) return res.status(404).json({ message: 'User not found' });

//     req.userAdAccountID = user.accountId;
//     next();
//   } catch (error) {
//     res.status(400).json({ message: 'Invalid Token' });
//   }
// }

// Save budget endpoint
app.post('/save-budget', authenticateToken, async (req, res) => {
  const { accountId, budget } = req.body; // Include accountId in the request body
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Update the budget for the specific ad account
    await adCampaignsCollection.updateOne(
      { userId: userId },
      { $set: { [`adCampaigns.${accountId}.budget`]: budget } }, // Save the budget under the specified accountId
      { upsert: true }
    );

    res.status(200).json({ message: 'Budget saved successfully' });
  } catch (error) {
    console.error('Error saving budget:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});
// Fetch budget endpoint
app.get('/get-budget', authenticateToken, async (req, res) => {
  const { accountId } = req.query;
  const userId = req.user.userId;

  if (!accountId) {
    return res.status(400).json({ message: 'Account ID is required' });
  }

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Retrieve the ad campaigns document for the user
    const adCampaignsDoc = await adCampaignsCollection.findOne({ userId });

    // Check if the ad account exists and has a budget
    const budget = adCampaignsDoc?.adCampaigns?.[accountId]?.budget || null;

    if (budget !== null) {
      res.status(200).json({ budget });
    } else {
      res.status(404).json({ message: 'Ad account or budget not found' });
    }
  } catch (error) {
    console.error('Error fetching budget:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// API route to update the logged-in user's ad account ID
app.post('/update-account-id', authenticateToken, async (req, res) => {
  const { accountId } = req.body;

  try {
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');
    
    const email = req.user.email;
    
    await usersCollection.updateOne({ email }, { $set: { accountId } });
    
    res.status(200).json({ message: 'Account ID updated successfully' });
  } catch (error) {
    console.error('Error updating account ID:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// API route to fetch the logged-in user's profile
app.get('/user-profile', authenticateToken, async (req, res) => {
  try {
    const user = await client.db('black-licorice').collection('users').findOne(
      { linkedinId: req.user.linkedinId }, 
      { projection: { email: 1, firstName: 1, lastName: 1, adAccounts: 1 } }
    );
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      adAccounts: user.adAccounts.map(acc => ({
        id: acc.accountId,
        name: acc.name // Assuming the name of the ad account is fetched
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// User registration route
app.post('/signup', async (req, res) => {
  const { email, password, rePassword, accountId } = req.body;
  
  if (password !== rePassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  if (!/^\d{9}$/.test(accountId)) {
    return res.status(400).json({ message: 'Account ID must be a 9-digit number' });
  }

  try {
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email });

    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10); // bcrypt usage
    const newUser = {
      email,
      password: hashedPassword,
      accountId, // Save accountId to the user profile
      userId: uuidv4(),
    };

    await usersCollection.insertOne(newUser);
    const token = jwt.sign(
      { 
        linkedinId: newUser.linkedinId,  // Assuming you're using linkedinId for identification
        userId: newUser.userId 
      }, 
      process.env.LINKEDIN_CLIENT_SECRET,  // This should pull the key from your .env file
      { expiresIn: '1h' }
    );
    
    res.status(201).json({ token });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Simple test route
app.get('/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});


// User login route
app.post('/login', async (req, res) => {
  const { linkedinId, password } = req.body;  // No email, just linkedinId and password for login

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ linkedinId });
    if (!user) {
      return res.status(400).json({ message: 'Invalid LinkedIn ID or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid LinkedIn ID or password' });
    }

    // Generate the JWT token with linkedinId and userId (no email)
    const token = jwt.sign(
      {
        linkedinId: user.linkedinId,
        userId: user.userId,  // Include userId in the token
      },
      process.env.LINKEDIN_CLIENT_SECRET,
      { expiresIn: '1h' }
    );

    // Send the token to the client
    res.json({ token });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Backend route to update a campaign group
// Update an existing campaign group
// Backend route to update a campaign group
app.post('/update-campaign-group', authenticateToken, async (req, res) => {
  const { group, accountId } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Use the $set operator to update the fields of the matching group
    const updateResult = await adCampaignsCollection.updateOne(
      { userId, [`adCampaigns.${accountId}.campaignGroups.id`]: group.id },
      {
        $set: {
          [`adCampaigns.${accountId}.campaignGroups.$[elem].name`]: group.name,
          [`adCampaigns.${accountId}.campaignGroups.$[elem].budget`]: group.budget !== null ? group.budget : null,
          [`adCampaigns.${accountId}.campaignGroups.$[elem].campaignIds`]: group.campaignIds,
        },
      },
      { arrayFilters: [{ "elem.id": group.id }] }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(404).json({ message: 'Campaign group not found or no changes made' });
    }

    res.status(200).json({ message: 'Campaign group updated successfully' });
  } catch (error) {
    console.error('Error updating campaign group:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});
// Backend route to delete a campaign group
// Delete a campaign group from the specified ad account
// Backend route to delete a campaign group
app.post('/delete-campaign-group', authenticateToken, async (req, res) => {
  const { groupId, accountId } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Use $pull to remove the group from the specified ad account
    const deleteResult = await adCampaignsCollection.updateOne(
      { userId, [`adCampaigns.${accountId}.campaignGroups.id`]: groupId },
      { $pull: { [`adCampaigns.${accountId}.campaignGroups`]: { id: groupId } } }
    );

    if (deleteResult.modifiedCount === 0) {
      return res.status(404).json({ message: 'Campaign group not found or could not be deleted' });
    }

    res.status(200).json({ message: 'Campaign group deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign group:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Fetch campaign groups for a specific ad account
app.get('/user-campaign-groups', authenticateToken, async (req, res) => {
  const { accountId } = req.query;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });

    if (!adCampaignsDoc || !adCampaignsDoc.adCampaigns[accountId]) {
      return res.status(404).json({ error: 'Ad account not found' });
    }

    const campaignGroups = adCampaignsDoc.adCampaigns[accountId].campaignGroups || [];
    res.status(200).json({ groups: campaignGroups });
  } catch (error) {
    console.error('Error fetching campaign groups:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Endpoint to save campaign groups to user doc
// Endpoint to save campaign groups to user doc
// Revised save-campaign-groups endpoint
app.post('/save-campaign-groups', authenticateToken, async (req, res) => {
  const { group, accountId } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Check if the user document and account structure already exist
    const adAccountPath = `adCampaigns.${accountId}.campaignGroups`;
    const existingDoc = await adCampaignsCollection.findOne({ userId, [`adCampaigns.${accountId}`]: { $exists: true } });

    if (!existingDoc) {
      // Create new document or account structure if it doesn't exist
      await adCampaignsCollection.updateOne(
        { userId },
        { $set: { [`adCampaigns.${accountId}.campaignGroups`]: [group] } },
        { upsert: true }
      );
    } else {
      // Add the group to the existing array using $addToSet to avoid duplicates
      await adCampaignsCollection.updateOne(
        { userId },
        { $addToSet: { [adAccountPath]: group } }
      );
    }

    res.status(200).json({ message: 'Campaign group saved successfully' });
  } catch (error) {
    console.error('Error saving campaign group:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get campaigns for the logged-in user
app.get('/get-current-campaigns', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { accountId } = req.query;

  if (!accountId) {
    return res.status(400).json({ message: 'Account ID is required' });
  }

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });

    // Check if the ad account exists and has campaigns
    const campaigns = adCampaignsDoc?.adCampaigns[accountId].campaigns || [];

    res.json({ campaigns });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Save campaigns for the logged-in user
// app.post('/save-campaigns', authenticateToken, async (req, res) => {
//   const { campaigns } = req.body;
//   const userId = req.user.userId;

//   try {
//     await client.connect();
//     const db = client.db('black-licorice');
//     const collection = db.collection('campaigns');

//     // Check if a document for the user already exists
//     const existingDoc = await collection.findOne({ userId });

//     if (existingDoc) {
//       // Update the existing document
//       await collection.updateOne(
//         { userId },
//         { $set: { elements: campaigns } }
//       );
//       res.send('Campaigns updated successfully');
//     } else {
//       // Insert a new document
//       await collection.insertOne({ userId, elements: campaigns });
//       res.send('Campaigns saved successfully');
//     }
//   } catch (error) {
//     console.error('Error saving campaigns to MongoDB:', error);
//     res.status(500).send('Internal Server Error');
//   }
// });

app.post('/save-changes', authenticateToken, async (req, res) => {
  const { changes, adAccountId } = req.body; 
  const userId = req.user.userId;

  try {
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    // Find or insert the user’s document and update changes
    const existingUserChanges = await changesCollection.findOne({ userId });
    const changesWithIds = changes.map(change => ({
      ...change,
      _id: change._id ? new ObjectId(change._id) : new ObjectId()
    }));
    
    if (existingUserChanges) {
      const existingAdAccountChanges = existingUserChanges.changes[adAccountId] || [];
      const uniqueChanges = changesWithIds.filter(newChange =>
        !existingAdAccountChanges.some(existingChange =>
          existingChange._id.equals(newChange._id) ||
          (existingChange.campaign === newChange.campaign &&
           existingChange.date === newChange.date &&
           existingChange.changes === newChange.changes)
        )
      );

      if (uniqueChanges.length > 0) {
        await changesCollection.updateOne(
          { userId },
          { $push: { [`changes.${adAccountId}`]: { $each: uniqueChanges } } }
        );
      }
    } else {
      await changesCollection.insertOne({
        userId,
        changes: { [adAccountId]: changesWithIds }
      });
    }
    res.status(200).send('Changes saved successfully');
  } catch (error) {
    console.error('Error saving changes to MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Add Note Endpoint
app.post('/add-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, newNote } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');

    const note = { _id: new ObjectId(), note: newNote, timestamp: new Date().toISOString() };

    const result = await db.collection('adCampaigns').updateOne(
      { userId, [`adAccounts.${accountId}.campaigns._id`]: campaignId },
      { $push: { [`adAccounts.${accountId}.campaigns.$.notes`]: note } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send('Campaign not found');
    }

    res.send('Note added successfully');
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Edit Note Endpoint
app.post('/edit-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, noteId, updatedNote } = req.body;
  const userId = req.user.userId;

  if (!accountId || !campaignId || !noteId || !updatedNote) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    await client.connect();
    const db = client.db('black-licorice');

    const result = await db.collection('adCampaigns').updateOne(
      { userId, [`adAccounts.${accountId}.campaigns._id`]: campaignId },
      { 
        $set: { 
          [`adAccounts.${accountId}.campaigns.$[campaignElem].notes.$[noteElem].note`]: updatedNote,
          [`adAccounts.${accountId}.campaigns.$[campaignElem].notes.$[noteElem].timestamp`]: new Date().toISOString()
        } 
      },
      {
        arrayFilters: [
          { "campaignElem._id": campaignId },
          { "noteElem._id": new ObjectId(noteId) }
        ]
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send('Note not found');
    }

    res.send('Note updated successfully');
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Delete Note Endpoint
app.post('/delete-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, noteId } = req.body;
  const userId = req.user.userId;

  if (!accountId || !campaignId || !noteId) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    await client.connect();
    const db = client.db('black-licorice');

    const result = await db.collection('adCampaigns').updateOne(
      { userId, [`adAccounts.${accountId}.campaigns._id`]: campaignId },
      { $pull: { [`adAccounts.${accountId}.campaigns.$[campaignElem].notes`]: { _id: new ObjectId(noteId) } } },
      {
        arrayFilters: [
          { "campaignElem._id": campaignId }
        ]
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send('Note not found');
    }

    res.send('Note deleted successfully');
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/get-all-changes', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { adAccountId } = req.query;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const userChanges = await db.collection('changes').findOne({ userId });
    console.log("🐒 ~ userChanges:", userChanges)

    if (userChanges && userChanges.changes[adAccountId]) {
      res.json(userChanges.changes[adAccountId]);
    } else {
      res.json([]); // Return an empty array if no changes are found for the ad account
    }
  } catch (error) {
    console.error('Error fetching changes from MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/save-campaigns', authenticateToken, async (req, res) => {
  const { campaigns, accountId } = req.body;
  const userId = req.user.userId;

  if (!accountId) {
    return res.status(400).json({ message: 'Account ID is required' });
  }

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const adCampaignsCollection = db.collection('adCampaigns');

    // Update the campaigns for the specified ad account inside adCampaigns, not adAccounts
    await adCampaignsCollection.updateOne(
      { userId },
      { $set: { [`adCampaigns.${accountId}.campaigns`]: campaigns } },
      { upsert: true }
    );

    res.status(200).json({ message: 'Campaigns saved successfully' });
  } catch (error) {
    console.error('Error saving campaigns:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get('/linkedin', authenticateToken, async (req, res) => {
  const { start, end, campaigns } = req.query;

  const startDate = new Date(start);
  const endDate = new Date(end);

  try {
    // Fetch the userAdAccountID from the database using the user's LinkedIn ID
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });

    if (!user) {
      console.error('User not found for LinkedIn ID:', req.user.linkedinId);
      return res.status(404).json({ error: 'User not found' });
    }

    const userAdAccountID = user.adAccounts?.[0]?.accountId.split(':').pop(); // Extract the numeric account ID from URN
    const linkedInToken = user.accessToken; // Assuming the token is stored with the user

    if (!userAdAccountID) {
      console.error('User Ad Account ID not found for user:', req.user.linkedinId);
      return res.status(400).json({ error: 'User Ad Account ID not found' });
    }

    if (!linkedInToken) {
      console.error('LinkedIn Access Token not found for user:', req.user.linkedinId);
      return res.status(400).json({ error: 'LinkedIn Access Token not found' });
    }


    // LinkedIn API URL with dynamic userAdAccountID
    let url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:${startDate.getFullYear()},month:${startDate.getMonth() + 1},day:${startDate.getDate()}),end:(year:${endDate.getFullYear()},month:${endDate.getMonth() + 1},day:${endDate.getDate()}))&timeGranularity=DAILY&pivot=CAMPAIGN&accounts=List(urn%3Ali%3AsponsoredAccount%3A${userAdAccountID})&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues`;

    // Add campaign filter if provided
    if (campaigns) {
      url += `&campaigns=${campaigns}`;
    }


    // Make the request to LinkedIn API
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${linkedInToken}`, // Use LinkedIn token
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });


    res.json(response.data); // Send back the API response
  } catch (error) {
    console.error('Error fetching data from LinkedIn API:', error.message);
    console.error('Error details:', error.response ? error.response.data : 'No response data available');
    return res.status(error.response?.status || 500).send(error.message);
  }
});

app.get('/ad-account-name', authenticateToken, async (req, res) => {
  try {
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });

    if (!user || !user.adAccounts || user.adAccounts.length === 0) {
      return res.status(404).json({ error: 'Ad accounts not found for this user' });
    }

    const token = user.accessToken;

    const adAccountNames = await Promise.all(
      user.adAccounts.map(async (account) => {
        const userAdAccountID = account.accountId.split(':').pop();
        const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}`;

        try {
          const response = await axios.get(apiUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-RestLi-Protocol-Version': '2.0.0',
              'LinkedIn-Version': '202406',
            },
          });

          // Check if the response has the necessary data
          if (response.data && response.data.name) {
            return { id: account.accountId, name: response.data.name };
          } else {
            console.warn(`No name found for account ${account.accountId}`);
            return { id: account.accountId, name: 'Unknown' };
          }
        } catch (error) {
          if (error.response && error.response.status === 404) {
            // Skip this account if the API returns a 404 error
            console.warn(`Skipping account ${account.accountId}: Not found (404)`);
            return null; // Return null to indicate that this account should be skipped
          } else {
            console.error(`Error fetching name for account ${account.accountId}:`, error.message);
            return { id: account.accountId, name: 'Unknown' };
          }
        }
      })
    );

    // Filter out any null values (accounts that were skipped)
    const validAdAccounts = adAccountNames.filter(account => account !== null);

    // If no valid accounts were found, send a 404 error
    if (validAdAccounts.length === 0) {
      return res.status(404).json({ error: 'No valid ad accounts found for this user' });
    }

    // Update the user document with the fetched account names if needed
    await client.db('black-licorice').collection('users').updateOne(
      { linkedinId: req.user.linkedinId },
      { $set: { 'adAccounts.$[elem].name': { $each: validAdAccounts.map(acc => acc.name) } } },
      { arrayFilters: [{ 'elem.accountId': { $in: validAdAccounts.map(acc => acc.id) } }] }
    );

    res.json({ adAccounts: validAdAccounts });
  } catch (error) {
    console.error('Error fetching ad account names:', error);
    res.status(error.response?.status || 500).send('Error fetching ad account names');
  }
});

app.get('/linkedin/ad-campaigns', authenticateToken, async (req, res) => {
  const { accountIds } = req.query; // Expecting an array of account IDs

  if (!accountIds || accountIds.length === 0) {
    return res.status(400).json({ error: 'No accountIds provided' });
  }

  try {
    // Find the user in the database based on the authenticated LinkedIn ID
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = user.userId; // Get the user's ID from the database
    const adCampaigns = {};

    // Fetch the existing adCampaigns document for the user
    const db = client.db('black-licorice');
    const existingAdCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });

    // Loop through each accountId and get the ad campaigns for each
    for (const accountId of accountIds) {
      const userAdAccountID = accountId.split(':').pop();
      const token = user.accessToken;

      const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

      try {
        const response = await axios.get(apiUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-RestLi-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202406',
          },
        });

        // Get existing data for the current ad account if it exists
        const existingCampaigns = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaigns || [];
        const existingCampaignGroups = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaignGroups || [];
        const existingBudget = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.budget || null;

        // Store the campaigns under the ad account ID key, preserving existing budget
        adCampaigns[accountId] = {
          campaigns: response.data.elements || [],
          campaignGroups: existingCampaignGroups, // Preserve the existing campaign groups
          budget: existingBudget // Preserve the existing budget
        };
      } catch (error) {
        console.error(`Error fetching ad campaigns for accountId ${accountId}:`, error);
        adCampaigns[accountId] = {
          campaigns: existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaigns || [],
          campaignGroups: existingCampaignGroups, // Preserve existing data in case of error
          budget: existingBudget // Preserve the existing budget
        };
      }
    }

    // Add empty arrays for any ad accounts that weren't processed
    user.adAccounts.forEach(account => {
      const id = account.accountId;
      if (!adCampaigns.hasOwnProperty(id)) {
        adCampaigns[id] = {
          campaigns: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaigns || [],
          campaignGroups: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaignGroups || [],
          budget: existingAdCampaignsDoc?.adCampaigns?.[id]?.budget || null
        };
      }
    });

    // Save the updated ad campaigns to the database with the userId
    await db.collection('adCampaigns').updateOne(
      { userId },
      { $set: { adCampaigns } },
      { upsert: true }
    );

    // Return the ad campaigns data to the client
    res.json({
      userId,
      adCampaigns,
    });
  } catch (error) {
    console.error('Error fetching ad campaigns:', error);
    res.status(500).send('Error fetching ad campaigns');
  }
});


app.get('/get-all-changes', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { adAccountId } = req.query;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const userChanges = await db.collection('changes').findOne({ userId });

    if (userChanges && userChanges.changes[adAccountId]) {
      res.json(userChanges.changes[adAccountId]);
    } else {
      res.json([]); // Return an empty array if no changes are found for the ad account
    }
  } catch (error) {
    console.error('Error fetching changes from MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/linkedin/ad-campaign-groups', authenticateToken, async (req, res) => {
  try {
    // Fetch the user from the database using LinkedIn ID
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });

    if (!user || !user.adAccounts || user.adAccounts.length === 0) {
      return res.status(404).json({ error: 'Ad accounts not found for this user' });
    }

    const userAdAccountID = user.adAccounts[0].accountId.split(':').pop();
    const token = user.accessToken;

    // LinkedIn API endpoint for ad campaign groups
    const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaignGroups?q=search&sortOrder=DESCENDING`;

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching ad campaign groups:', error);
    res.status(error.response?.status || 500).send('Error fetching ad campaign groups');
  }
});

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Start the server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


// https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CREATIVE&timeGranularity=DAILY&dateRange=(start:(year:2024,month:6,day:1))&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446)

// https://api.linkedin.com/rest/adAnalytics?q=statistics&pivots=CREATIVE&dateRange=(start:(year:2024,month:6,day:1))&timeGranularity=DAILY&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446)

// https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2023,month:6,day:1),end:(year:2024,month:9,day:30))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&pivot=COMPANY&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues


// https://api.linkedin.com/rest/adAccounts/512388408/adCampaigns?q=search&search=(type:(values:List(SPONSORED_UPDATES)),status:(values:List(ACTIVE)))&sortOrder=DESCENDING



// List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)

// https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2024,month:6,day:1),end:(year:2024,month:6,day:24))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)&pivot=CAMPAIGN&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions
// Newest https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2024,month:6,day:1),end:(year:2024,month:6,day:24))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)&pivot=CAMPAIGN&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues


// Get user list
// https://api.linkedin.com/rest/adAccountUsers?q=accounts&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)