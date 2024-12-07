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
import cookieParser from 'cookie-parser';

dotenv.config(); // Load environment variables

const app = express();
app.use(express.json());
app.use(cookieParser());


app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL_PROD : process.env.FRONTEND_URL_DEV,
  credentials: true, // allows sending cookies and auth headers
}));
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

const formatDate = (date) => {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  return new Date(date).toLocaleDateString('en-US', options);
};

// MongoDB client setup
const url = 'mongodb+srv://jjnothere:GREATpoop^6^@black-licorice-cluster.5hb9ank.mongodb.net/?retryWrites=true&w=majority&appName=black-licorice-cluster';
const client = new MongoClient(url);

// LinkedIn Strategy for OAuth 2.0
const callbackURL = process.env.NODE_ENV === 'production'
  ? process.env.CALLBACK_URL_PROD
  : process.env.CALLBACK_URL_DEV;

passport.use(new LinkedInStrategy({
  clientID: process.env.LINKEDIN_CLIENT_ID,
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
  callbackURL: callbackURL,
  scope: ['r_ads_reporting', 'r_ads', 'rw_ads', 'r_basicprofile'],
}, (accessToken, refreshToken, profile, done) => {
  return done(null, { profile, accessToken, refreshToken });
}));

// LinkedIn authentication route
app.get('/auth/linkedin', (req, res, next) => {
  next();
}, passport.authenticate('linkedin'));

// LinkedIn callback route
app.get('/auth/linkedin/callback',
  passport.authenticate('linkedin', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      const { accessToken, profile } = req.user;

      if (!accessToken) {
        console.error('Error: Access token not found');
        return res.status(400).json({ error: 'Access token not found' });
      }

      await client.connect();
      const db = client.db('black-licorice');
      const usersCollection = db.collection('users');
      const linkedinId = profile.id;
      const firstName = profile.name.givenName;
      const lastName = profile.name.familyName;

      const adAccountsUrl = `https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser`;
      const adAccountsResponse = await axios.get(adAccountsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      });

      const adAccounts = adAccountsResponse.data.elements.map(account => ({
        accountId: account.account.split(':').pop(),
        role: account.role,
      }));

      const existingUser = await usersCollection.findOne({ linkedinId });
      let user;

      if (existingUser) {
        await usersCollection.updateOne(
          { linkedinId },
          {
            $set: {
              accessToken,
              firstName,
              lastName,
              lastLogin: new Date(),
              adAccounts,
            },
          }
        );
        user = existingUser;
      } else {
        const newUser = {
          linkedinId,
          accessToken,
          firstName,
          lastName,
          userId: uuidv4(),
          createdAt: new Date(),
          adAccounts,
        };
        await usersCollection.insertOne(newUser);
        user = newUser;
      }

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

      // Set the tokens in cookies
      res.cookie('accessToken', jwtAccessToken, {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 2 * 60 * 60 * 1000, // 2 hours
      });
      
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });


      const frontendUrl = process.env.NODE_ENV === 'production'
        ? process.env.FRONTEND_URL_PROD
        : process.env.FRONTEND_URL_DEV;

      // Redirect to the frontend history page after successful login
      if (!res.headersSent) {
        return res.redirect(`${frontendUrl}/history`);
      }

    } catch (error) {
      console.error('Error in LinkedIn callback:', error);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Internal Server Error' });
      }
    }
  }
);

// Token verification middleware
const authenticateToken = (req, res, next) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ message: 'Access Denied' });
  }

  try {
    // Verify the access token
    jwt.verify(token, process.env.LINKEDIN_CLIENT_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ message: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    });
  } catch (error) {
    return res.status(403).json({ message: 'Invalid Token' });
  }
};

app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    await usersCollection.updateOne({ linkedinId: req.user.linkedinId }, { $unset: { refreshToken: '' } });

    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.post('/api/refresh-token', (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(403).json({ message: 'Refresh token required' });
  }

  try {
    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);

    // Generate a new access token
    const newAccessToken = jwt.sign(
      { userId: decoded.userId, linkedinId: decoded.linkedinId },
      process.env.LINKEDIN_CLIENT_SECRET,
      { expiresIn: '1h' }
    );

    // Optionally, issue a new refresh token if necessary
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId, linkedinId: decoded.linkedinId },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    // Update cookies with the new tokens
    res.cookie('accessToken', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 1000, // 1 hour
    });

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ message: 'Access token refreshed' });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(403).json({ message: 'Invalid refresh token' });
  }
});

// Endpoint to fetch LinkedIn ad campaign groups and map campaigns to each group
app.get('/api/linkedin/linkedin-ad-campaign-groups', authenticateToken, async (req, res) => {
  const { accountId } = req.query;

  if (!accountId) {
    return res.status(400).json({ error: 'Account ID is required' });
  }

  try {
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });

    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or access token not found' });
    }

    const token = user.accessToken;
    const userAdAccountID = accountId.split(':').pop();

    const campaignGroupsUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaignGroups?q=search&sortOrder=DESCENDING`;
    const campaignsUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

    const [groupsResponse, campaignsResponse] = await Promise.all([
      axios.get(campaignGroupsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      }),
      axios.get(campaignsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      }),
    ]);

    // Log the campaigns response data
    const campaigns = campaignsResponse.data.elements || [];
    const campaignGroups = groupsResponse.data.elements.map(group => ({
      ...group,
      campaigns: campaigns.filter(campaign => {
        // Extract the numeric ID from the URN string
        const campaignGroupId = campaign.campaignGroup.split(':').pop();
        return campaignGroupId === String(group.id); // Compare as strings
      }),
      visible: false,
    }));

    res.json(campaignGroups);
  } catch (error) {
    console.error('Error fetching ad campaign groups or campaigns:', error);
    res.status(500).send('Error fetching ad campaign groups or campaigns');
  }
});
// Test route
app.get('/api/protected', authenticateToken, (req, res) => {
  res.json({ message: 'You have access to protected route' });
});

// const LINKEDIN_CLIENT_SECRET = '10e9b23966ddb67730a76de7cbaa4f58b06f18a8d11d181888d4ee5b3412d06b';

// test

// const token = 'AQXwqFy0cEEA9Di606cATO0NJ56KzGr75cZi-lfwLiL7rRYCqDitp-P2js3nX_tiWXY5vd2Yr8qJrYp1jQCwOa-j0hws_RGY7M5jyANYtR0IxrrGZlz8QhrZFi7PnQLr7qRgwiTru7Utz_jNNsDfaYzNW32lcbxskoGUKG6QeLclt8chdbiCuQAYYwFvgokm8Wx3-UhurZjgQrfHdIghBpQogNG650qG5r7WqQ-ROstfqOZYwVBxOX1fiD_hpLB3RqUwzjNRrcLs2gF_Vs0_WtY66VrD3VsTTUwcjKZy9BlDYwMLP68YuBp-G0A2WGxiHndV7VmNumDI5QRQmE4DlKqoeLfG0w';
// rf AQUcMDVwnfzMXs6_oRe67OxcrOhYrMrVco2vHh7mybvvWbxJ8LbWdN9evnnm0a5_DLlimngrbLWXjGoxlSPlx0AXsNhPbmMEztKUtgiBK3hp8qGNkZYeyY7ZlV0ljOmHZNxr-r8BIkOg5ARvmuUsUerWMkMzEFSTWtmvQnKf4f6YCn7vD7A1QmkXHr5ZjsvS7sCybreVSNAwBiCHC2BfZnCPWraIANlFqrFiNpnE5gKY7g73M-0CD9PMLLo5RR4SeBrgbeyb8OwjUESB7pMmlgNxrpOdzFG9K4dtWs_fGg46pZoAx_XSkPKwhYBjHWp4DG6Fy-5Grq0ccUR1YAf8Yyf0zkrhFw

// Initialize Express app



// Enable CORS for development
// Schedule the checkForChanges function to run every day at 2:15 PM


// cron.schedule('27 0 * * *', async () => {
//   try {
//     await checkForChangesForAllUsers();
//   } catch (error) {
//     console.error('Error running scheduled checkForChangesForAllUsers:', error);
//   }
// });

// Function to iterate through all users and check for campaign changes
async function checkForChangesForAllUsers() {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    // Fetch all users from the database
    const users = await usersCollection.find({}).toArray();

    for (const user of users) {
      const { userId, accessToken, adAccounts } = user;
      if (!accessToken) {
        console.warn(`Access token missing for user ${userId}`);
        continue;
      }

      // Loop through each ad account of the user
      for (const account of adAccounts) {
        const accountId = account.accountId;
        try {
          // Check for changes in campaigns for the current user and ad account
          await checkForChanges(userId, accountId, accessToken, db);
        } catch (error) {
          console.error(`Error in checking changes for user ${userId}, account ${accountId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in checkForChangesForAllUsers:', error);
  }
}

// Function to fetch and check differences for a specific user and ad account
async function checkForChanges(userId, accountId, token, db) {
  const currentCampaigns = await fetchCurrentCampaigns(db, userId, accountId);
  const linkedInCampaigns = await fetchLinkedInCampaigns(accountId, token);

  const newDifferences = [];

  linkedInCampaigns.forEach((campaign2) => {
    const campaign1 = currentCampaigns.find((c) => c.id === campaign2.id);
    if (campaign1) {
      const changes = findDifferences(campaign1, campaign2);
      if (Object.keys(changes).length > 0) {
        newDifferences.push({
          campaign: campaign2.name,
          date: formatDate(new Date()), // Format the date here
          changes: changes,
          notes: campaign2.notes || [],
          _id: campaign1._id ? new ObjectId(campaign1._id) : new ObjectId(),
        });
      }
    } else {
      // Handle new campaigns if necessary
      newDifferences.push({
        campaign: campaign2.name,
        date: formatDate(new Date()), // Format the date here
        changes: { message: 'New campaign added' },
        notes: [],
        _id: new ObjectId(),
      });
    }
  });

  // Save updated campaigns and new differences
  await saveCampaigns(db, linkedInCampaigns, userId, accountId);
  await saveChanges(db, newDifferences, userId, accountId);
}

async function fetchCurrentCampaigns(db, userId, accountId) {
  const userCampaigns = await db.collection('adCampaigns').findOne({ userId: userId });
  return userCampaigns?.adCampaigns?.[accountId]?.campaigns || [];
}

async function fetchLinkedInCampaigns(accountId, token) {
  const apiUrl = `https://api.linkedin.com/rest/adAccounts/${accountId}/adCampaigns?q=search&sortOrder=DESCENDING`;

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    return response.data.elements || [];
  } catch (error) {
    console.error(`Error fetching LinkedIn campaigns for account ${accountId}:`, error);
    return [];
  }
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

const findDifferences = (obj1, obj2) => {
  const keyMapping = {
    account: 'Account',
    associatedEntity: 'Associated Entity',
    audienceExpansionEnabled: 'Audience Expansion',
    campaignGroup: 'Campaign Group',
    costType: 'Cost Type',
    creativeSelection: 'Creative Selection',
    dailyBudget: 'Daily Budget',
    format: 'Format',
    id: 'ID',
    locale: 'Locale',
    name: 'Name',
    objectiveType: 'Objective Type',
    offsiteDeliveryEnabled: 'Offsite Delivery',
    offsitePreferences: 'Offsite Preferences',
    optimizationTargetType: 'Optimization Target Type',
    pacingStrategy: 'Pacing Strategy',
    runSchedule: 'Run Schedule',
    servingStatuses: 'Serving Statuses',
    status: 'Status',
    storyDeliveryEnabled: 'Story Delivery',
    targetingCriteria: 'Targeting Criteria',
    test: 'Test',
    type: 'Campaign Type',
    unitCost: 'Unit Cost',
    version: 'Version'
  };

  const diffs = {};
  for (const key in obj1) {
    if (key === 'changeAuditStamps'|| key === 'version') continue; // Exclude changeAuditStamps
    if (JSON.stringify(obj1[key]) !== JSON.stringify(obj2[key])) {
      const mappedKey = keyMapping[key] || key; // Use mapped key if available
      diffs[mappedKey] = {
        oldValue: obj1[key],
        newValue: obj2[key],
      };
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
      _id: change._id ? new ObjectId(change._id) : new ObjectId(),
      // No need to process changes into HTML
    }));
  
    const existingUserChanges = await collection.findOne({ userId });
  
    if (existingUserChanges) {
      const existingAdAccountChanges = existingUserChanges.changes[adAccountId] || [];
  
      const uniqueChanges = changesWithIds.filter(newChange =>
        !existingAdAccountChanges.some(existingChange =>
          existingChange._id.equals(newChange._id) ||
          (existingChange.campaign === newChange.campaign &&
            existingChange.date === newChange.date &&
            JSON.stringify(existingChange.changes) === JSON.stringify(newChange.changes))
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

  // async function saveChanges(db, changes, userId, adAccountId) {
  //   const colorMapping = {
  //     Account: '#FF5733', // Bright Red
  //     'Associated Entity': '#33C3FF', // Light Blue
  //     'Audience Expansion': '#28A745', // Green
  //     'Campaign Group': '#AF7AC5', // Purple
  //     'Cost Type': '#FFB533', // Orange
  //     'Creative Selection': '#FF69B4', // Pink
  //     'Daily Budget': '#17A2B8', // Cyan
  //     Format: '#FFD700', // Gold/Yellow
  //     ID: '#FF33C9', // Magenta
  //     Locale: '#8B4513', // Saddle Brown
  //     Name: '#32CD32', // Lime Green
  //     'Objective Type': '#000080', // Navy Blue
  //     'Offsite Delivery': '#808000', // Olive Green
  //     'Offsite Preferences': '#20B2AA', // Light Sea Green
  //     'Optimization Target Type': '#800000', // Maroon
  //     'Pacing Strategy': '#FF4500', // Orange Red
  //     'Run Schedule': '#4682B4', // Steel Blue
  //     'Serving Statuses': '#1E90FF', // Dodger Blue
  //     Status: '#228B22', // Forest Green
  //     'Story Delivery': '#DC143C', // Crimson Red
  //     'Targeting Criteria': '#FF8C00', // Dark Orange
  //     Test: '#00CED1', // Dark Turquoise
  //     Type: '#9932CC', // Dark Orchid
  //     'Unit Cost': '#DAA520', // Goldenrod
  //     Version: '#FF6347' // Tomato
  //   };
  
  //   if (!adAccountId) {
  //     console.error("Error: adAccountId is undefined.");
  //     return; // Exit if adAccountId is not provided
  //   }
  
  //   const collection = db.collection('changes');
    
  //   const changesWithIds = changes.map(change => ({
  //     ...change,
  //     _id: change._id ? new ObjectId(change._id) : new ObjectId(),
  //     changes: Array.isArray(change.changes)
  //       ? change.changes.map(changeType => {
  //           const color = colorMapping[changeType] || 'black';
  //           return `<span style="color:${color};">${changeType}</span>`;
  //         }).join('<br>')
  //       : change.changes // If `changes` is not an array, use it directly
  //   }));
  
  //   const existingUserChanges = await collection.findOne({ userId });
  
  //   if (existingUserChanges) {
  //     const existingAdAccountChanges = existingUserChanges.changes[adAccountId] || [];
  
  //     const uniqueChanges = changesWithIds.filter(newChange =>
  //       !existingAdAccountChanges.some(existingChange =>
  //         existingChange._id.equals(newChange._id) ||
  //         (existingChange.campaign === newChange.campaign &&
  //           existingChange.date === newChange.date &&
  //           existingChange.changes === newChange.changes)
  //       )
  //     );
  
  //     if (uniqueChanges.length > 0) {
  //       await collection.updateOne(
  //         { userId },
  //         { $push: { [`changes.${adAccountId}`]: { $each: uniqueChanges } } }
  //       );
  //     }
  //   } else {
  //     await collection.insertOne({
  //       userId,
  //       changes: { [adAccountId]: changesWithIds }
  //     });
  //   }
  // }

// Route to get the user's ad accounts
app.get('/api/get-user-ad-accounts', authenticateToken, async (req, res) => {
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

app.get('/api/hello', async (req, res) => {
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
app.post('/api/save-budget', authenticateToken, async (req, res) => {
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
app.get('/api/get-budget', authenticateToken, async (req, res) => {
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
app.post('/api/update-account-id', authenticateToken, async (req, res) => {
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
app.get('/api/user-profile', authenticateToken, async (req, res) => {
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
app.post('/api/signup', async (req, res) => {
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
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});


// User login route
app.post('/api/login', async (req, res) => {
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
app.post('/api/update-campaign-group', authenticateToken, async (req, res) => {
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
app.post('/api/delete-campaign-group', authenticateToken, async (req, res) => {
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
app.get('/api/user-campaign-groups', authenticateToken, async (req, res) => {
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
app.post('/api/save-campaign-groups', authenticateToken, async (req, res) => {
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
app.get('/api/get-current-campaigns', authenticateToken, async (req, res) => {
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

app.post('/api/save-changes', authenticateToken, async (req, res) => {
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
        !existingAdAccountChanges.some(existingChange => {
          const existingChangeId = typeof existingChange._id === 'string'
            ? new ObjectId(existingChange._id)
            : existingChange._id;
          const newChangeId = typeof newChange._id === 'string'
            ? new ObjectId(newChange._id)
            : newChange._id;
      
          return (
            existingChangeId.equals(newChangeId) ||
            (existingChange.campaign === newChange.campaign &&
              existingChange.date === newChange.date &&
              JSON.stringify(existingChange.changes) === JSON.stringify(newChange.changes))
          );
        })
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

// Route to fetch targeting entities by skill and ID
app.get('/api/linkedin/targeting-entities', authenticateToken, async (req, res) => {
  let { urnType, urnId } = req.query;

  urnType = urnType?.trim();
  urnId = urnId?.trim();

  if (!urnType || !urnId) {
    return res.status(400).json({ error: 'urnType and urnId are required' });
  }

  try {
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or access token not found' });
    }

    const token = user.accessToken;
    const apiUrl = `https://api.linkedin.com/v2/adTargetingEntities?q=urns&urns=${encodeURIComponent(`urn:li:${urnType}:${urnId}`)}`;


    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': '202306',
      },
    });

    const targetingData = response.data.elements?.[0];
    if (targetingData) {
      res.json({ name: targetingData.name });
    } else {
      res.status(404).json({ error: 'No data found for the given URN' });
    }
  } catch (error) {
    console.error('Error fetching targeting entities:', error.response?.data || error.message);
    res.status(error.response?.status || 500).send('Error fetching targeting entities');
  }
});



// New route to get geo information from LinkedIn API
app.get('/api/linkedin/geo/:id', authenticateToken, async (req, res) => {
  const geoId = req.params.id;

  try {
    // Fetch the user from the database using LinkedIn ID
    const user = await client
      .db('black-licorice')
      .collection('users')
      .findOne({ linkedinId: req.user.linkedinId });

    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or access token not found' });
    }

    const token = user.accessToken;

    // LinkedIn API endpoint for geo information
    const apiUrl = `https://api.linkedin.com/v2/geo/${geoId}`;

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': '202306', // Use the appropriate API version
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching geo information:', error.response?.data || error.message);
    res.status(error.response?.status || 500).send('Error fetching geo information');
  }
});

// Add Note Endpoint
app.post('/api/add-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, newNote } = req.body;
  const userId = req.user.userId;

  try {
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    const note = { _id: new ObjectId(), note: newNote, timestamp: new Date().toISOString() };

    // Add the new note to the specific campaign within the specified ad account
    const result = await changesCollection.updateOne(
      { userId },
      { $push: { [`changes.${accountId}.$[elem].notes`]: note } },
      { arrayFilters: [{ "elem._id": new ObjectId(campaignId) }] }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send('Campaign not found');
    }

    res.send('Note added successfully');
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Edit Note Endpoint
app.post('/api/edit-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, noteId, updatedNote } = req.body;
  const userId = req.user.userId;

  if (!accountId || !campaignId || !noteId || !updatedNote) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    const result = await changesCollection.updateOne(
      { userId },
      {
        $set: {
          [`changes.${accountId}.$[campaignElem].notes.$[noteElem].note`]: updatedNote,
          [`changes.${accountId}.$[campaignElem].notes.$[noteElem].timestamp`]: new Date().toISOString()
        }
      },
      {
        arrayFilters: [
          { "campaignElem._id": new ObjectId(campaignId) },
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
app.post('/api/delete-note', authenticateToken, async (req, res) => {
  const { accountId, campaignId, noteId } = req.body;
  const userId = req.user.userId;

  if (!accountId || !campaignId || !noteId) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    const result = await changesCollection.updateOne(
      { userId },
      { $pull: { [`changes.${accountId}.$[campaignElem].notes`]: { _id: new ObjectId(noteId) } } },
      {
        arrayFilters: [
          { "campaignElem._id": new ObjectId(campaignId) }
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

app.get('/api/get-all-changes', authenticateToken, async (req, res) => {
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

app.post('/api/save-campaigns', authenticateToken, async (req, res) => {
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

app.get('/api/linkedin', authenticateToken, async (req, res) => {
  const { start, end, campaigns, accountId } = req.query;

  if (!accountId) {
    return res.status(400).json({ error: 'Account ID is required' });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  // Find the user's LinkedIn token and confirm access to the specified account
  const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });
  const userAdAccountID = user.adAccounts.find(acc => acc.accountId === accountId)?.accountId;

  if (!userAdAccountID) {
    return res.status(400).json({ error: 'Invalid account ID for this user' });
  }

  // Call LinkedIn API with the specific account ID
  let url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:${startDate.getFullYear()},month:${startDate.getMonth() + 1},day:${startDate.getDate()}),end:(year:${endDate.getFullYear()},month:${endDate.getMonth() + 1},day:${endDate.getDate()}))&timeGranularity=DAILY&pivot=CAMPAIGN&accounts=List(urn%3Ali%3AsponsoredAccount%3A${userAdAccountID})&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues`;

  if (campaigns) {
    url += `&campaigns=${campaigns}`;
  }

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching data from LinkedIn API:', error.message);
    res.status(500).send(error.message);
  }
});

app.get('/api/ad-account-name', authenticateToken, async (req, res) => {
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

app.get('/api/linkedin/ad-campaigns', authenticateToken, async (req, res) => {
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
        
// Route to get campaign names for a specific ad account
app.get('/api/linkedin/ad-campaign-names', authenticateToken, async (req, res) => {
  const { accountId } = req.query;

  if (!accountId) {
    return res.status(400).json({ error: 'Account ID is required' });
  }

  try {
    // Fetch the user from the database
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or access token not found' });
    }

    const token = user.accessToken;
    const userAdAccountID = accountId.split(':').pop();

    // LinkedIn API endpoint to get campaigns for the specified ad account
    const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });

    // Extract campaign names and IDs only
    const campaignNames = response.data.elements.map(campaign => ({
      id: campaign.id,
      name: campaign.name,
    }));

    res.json(campaignNames);
  } catch (error) {
    console.error('Error fetching campaign names:', error);
    res.status(error.response?.status || 500).send('Error fetching campaign names');
  }
});

app.get('/api/get-all-changes', authenticateToken, async (req, res) => {
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

app.get('/api/linkedin/ad-campaign-groups', authenticateToken, async (req, res) => {
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