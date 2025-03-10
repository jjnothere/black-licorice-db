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
  scope: ['r_ads_reporting', 'r_ads', 'r_basicprofile', 'r_organization_social'],
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
        maxAge: 2 * 60 * 60 * 1000, // 2 hour
      });
      res.cookie('refreshToken', refreshToken, {
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000
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
    console.warn('No token found in cookies.');
    return res.status(401).json({ message: 'Access Denied' });
  }

  try {
    jwt.verify(token, process.env.LINKEDIN_CLIENT_SECRET, (err, user) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(401).json({ message: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    });
  } catch (error) {
    console.error('Error verifying token:', error.message);
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

app.post('/api/refresh-token', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    console.error('No refresh token in request');
    return res.status(403).json({ message: 'Refresh token is required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const userId = decoded.userId;

    await client.connect();
    const db = client.db('black-licorice');
    const user = await db.collection('users').findOne({ userId });

    if (!user || user.refreshToken !== refreshToken) {
      console.error('Invalid or mismatched refresh token');
      return res.status(403).json({ message: 'Invalid refresh token' });
    }

    const newAccessToken = jwt.sign(
      { userId: user.userId, linkedinId: user.linkedinId },
      process.env.LINKEDIN_CLIENT_SECRET,
      { expiresIn: '2h' }
    );

    res.cookie('accessToken', newAccessToken, {
      maxAge: 2 * 60 * 60 * 1000, // 2 hour
    });

    res.status(200).json({ accessToken: newAccessToken });
  } catch (error) {
    console.error('Error refreshing token:', error.message);
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
// async function checkForChangesForAllUsers() {
//   try {
//     await client.connect();
//     const db = client.db('black-licorice');
//     const usersCollection = db.collection('users');

//     // Fetch all users from the database
//     const users = await usersCollection.find({}).toArray();

//     for (const user of users) {
//       const { userId, accessToken, adAccounts } = user;
//       if (!accessToken) {
//         console.warn(`Access token missing for user ${userId}`);
//         continue;
//       }

//       // Loop through each ad account of the user
//       for (const account of adAccounts) {
//         const accountId = account.accountId;
//         try {
//           // Check for changes in campaigns for the current user and ad account
//           await checkForChanges(userId, accountId, accessToken, db);
//         } catch (error) {
//           console.error(`Error in checking changes for user ${userId}, account ${accountId}:`, error);
//         }
//       }
//     }
//   } catch (error) {
//     console.error('Error in checkForChangesForAllUsers:', error);
//   }
// }

// Function to fetch and check differences for a specific user and ad account
// async function checkForChanges(userId, accountId, token, db) {
//   const currentCampaigns = await fetchCurrentCampaigns(db, userId, accountId);
//   const linkedInCampaigns = await fetchLinkedInCampaigns(accountId, token);

//   const newDifferences = [];

//   linkedInCampaigns.forEach((campaign2) => {
//     const campaign1 = currentCampaigns.find((c) => c.id === campaign2.id);
//     if (campaign1) {
//       const changes = findDifferences(campaign1, campaign2);
//       if (Object.keys(changes).length > 0) {
//         newDifferences.push({
//           campaign: campaign2.name,
//           date: formatDate(new Date()), // Format the date here
//           changes: changes,
//           notes: campaign2.notes || [],
//           _id: campaign1._id ? new ObjectId(campaign1._id) : new ObjectId(),
//         });
//       }
//     } else {
//       // Handle new campaigns if necessary
//       newDifferences.push({
//         campaign: campaign2.name,
//         date: formatDate(new Date()), // Format the date here
//         changes: { message: 'New campaign added' },
//         notes: [],
//         _id: new ObjectId(),
//       });
//     }
//   });

//   // Save updated campaigns and new differences
//   await saveCampaigns(db, linkedInCampaigns, userId, accountId);
//   await saveChanges(db, newDifferences, userId, accountId);
// }

// async function fetchCurrentCampaigns(db, userId, accountId) {
//   const userCampaigns = await db.collection('adCampaigns').findOne({ userId: userId });
//   return userCampaigns?.adCampaigns?.[accountId]?.campaigns || [];
// }

// async function fetchLinkedInCampaigns(accountId, token) {
//   const apiUrl = `https://api.linkedin.com/rest/adAccounts/${accountId}/adCampaigns?q=search&sortOrder=DESCENDING`;

//   try {
//     const response = await axios.get(apiUrl, {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'X-RestLi-Protocol-Version': '2.0.0',
//         'LinkedIn-Version': '202406',
//       },
//     });
//     return response.data.elements || [];
//   } catch (error) {
//     console.error(`Error fetching LinkedIn campaigns for account ${accountId}:`, error);
//     return [];
//   }
// }

// async function saveCampaigns(db, campaigns, userId) {
//   const collection = db.collection('campaigns');
//   const existingDoc = await collection.findOne({ userId: userId });

//   if (existingDoc) {
//     await collection.updateOne({ userId: userId }, { $set: { elements: campaigns } });
//   } else {
//     await collection.insertOne({ userId: userId, elements: campaigns });
//   }
// }

// const findDifferences = (obj1, obj2) => {
//   const keyMapping = {
//     account: 'Account',
//     associatedEntity: 'Associated Entity',
//     audienceExpansionEnabled: 'Audience Expansion',
//     campaignGroup: 'Campaign Group',
//     costType: 'Cost Type',
//     creativeSelection: 'Creative Selection',
//     dailyBudget: 'Daily Budget',
//     format: 'Format',
//     id: 'ID',
//     locale: 'Locale',
//     name: 'Name',
//     objectiveType: 'Objective Type',
//     offsiteDeliveryEnabled: 'Offsite Delivery',
//     offsitePreferences: 'Offsite Preferences',
//     optimizationTargetType: 'Optimization Target Type',
//     pacingStrategy: 'Pacing Strategy',
//     runSchedule: 'Run Schedule',
//     servingStatuses: 'Serving Statuses',
//     status: 'Status',
//     storyDeliveryEnabled: 'Story Delivery',
//     targetingCriteria: 'Targeting Criteria',
//     test: 'Test',
//     type: 'Campaign Type',
//     unitCost: 'Unit Cost',
//     version: 'Version'
//   };

//   const diffs = {};
//   for (const key in obj1) {
//     if (key === 'changeAuditStamps'|| key === 'version') continue; // Exclude changeAuditStamps
//     if (JSON.stringify(obj1[key]) !== JSON.stringify(obj2[key])) {
//       const mappedKey = keyMapping[key] || key; // Use mapped key if available
//       diffs[mappedKey] = {
//         oldValue: obj1[key],
//         newValue: obj2[key],
//       };
//     }
//   }
//   return diffs;
// };


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
      { expiresIn: '2h' }
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
      { expiresIn: '2h' }
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

app.get('/api/linkedin/adSegments/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });
  if (!user || !user.accessToken) {
    return res.status(404).json({ error: 'User or access token not found' });
  }

  const token = user.accessToken;
  const apiUrl = `https://api.linkedin.com/rest/adSegments/${id}`;

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });

    const data = response.data;
    if (data && data.name) {
      res.json({ name: data.name });
    } else {
      res.status(404).json({ error: 'No data found for the given adSegment ID' });
    }
  } catch (error) {
    console.error(`Error fetching adSegment ${id}:`, error.response?.data || error.message);
    res.status(error.response?.status || 500).send(`Error fetching adSegment ${id}`);
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
    const apiUrl = `https://api.linkedin.com/rest/adTargetingEntities?q=urns&urns=${encodeURIComponent(`urn:li:${urnType}:${urnId}`)}`;


    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': '202406',
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
// app.get('/api/linkedin/geo/:id', authenticateToken, async (req, res) => {
//   const geoId = req.params.id;

//   try {
//     // Fetch the user from the database using LinkedIn ID
//     const user = await client
//       .db('black-licorice')
//       .collection('users')
//       .findOne({ linkedinId: req.user.linkedinId });

//     if (!user || !user.accessToken) {
//       return res.status(404).json({ error: 'User or access token not found' });
//     }

//     const token = user.accessToken;

//     // LinkedIn API endpoint for geo information
//     const apiUrl = `https://api.linkedin.com/v2/geo/${geoId}`;

//     const response = await axios.get(apiUrl, {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'LinkedIn-Version': '202306', // Use the appropriate API version
//       },
//     });

//     res.json(response.data);
//   } catch (error) {
//     console.error('Error fetching geo information:', error.response?.data || error.message);
//     res.status(error.response?.status || 500).send('Error fetching geo information');
//   }
// });

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

// Backend route to fetch campaign group name
app.get('/api/linkedin/ad-campaign-group-name', authenticateToken, async (req, res) => {
  const { accountId, groupId } = req.query;

  if (!accountId || !groupId) {
    return res.status(400).json({ error: 'Account ID and Group ID are required' });
  }

  try {
    // Fetch the user and access token
    const user = await client.db('black-licorice').collection('users').findOne({ linkedinId: req.user.linkedinId });
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or access token not found' });
    }

    const token = user.accessToken;
    const userAdAccountID = accountId.split(':').pop();

    // LinkedIn API endpoint
    const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaignGroups/${groupId}`;

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });

    // Return the name of the campaign group
    const name = response.data?.name || 'Unknown';
    res.json({ name });
  } catch (error) {
    console.error('Error fetching campaign group name:', error.response?.data || error.message);
    res.status(error.response?.status || 500).send('Error fetching campaign group name');
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
    // Fetch the existing adCampaigns document for the user
    const db = client.db('black-licorice');
    const existingAdCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });

    // Loop through each accountId and get the ad campaigns for each
    for (const accountId of accountIds) {
      const userAdAccountID = accountId.split(':').pop();
      const token = user.accessToken;

      const campaignsApiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

      try {
        // Fetch ad campaigns for the current account
        const response = await axios.get(campaignsApiUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-RestLi-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202406',
          },
        });

        // Map over each campaign and fetch creatives tied to it
        const campaignsWithCreatives = await Promise.all(
          response.data.elements.map(async (campaign) => {
            try {
              const campaignId = 'urn:li:sponsoredCampaign:' + campaign.id; // Extract campaign ID
              const creativesApiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/creatives?q=criteria&campaigns=List(${encodeURIComponent(campaignId)})&fields=id,isServing,content`;

              const creativesResponse = await axios.get(creativesApiUrl, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  'X-RestLi-Protocol-Version': '2.0.0',
                  'LinkedIn-Version': '202406',
                },
              });

              // Process each creative and set its name
              campaign.creatives = await Promise.all(
                creativesResponse.data.elements.map(async (creative) => {
                  if (creative.content?.textAd?.headline) {
                    // Use the headline as the name
                    creative.name = creative.content.textAd.headline;
                  } else if (creative.content?.reference) {
                    // Fetch additional data to get the dscName
                    const referenceId = creative.content.reference;
                    try {
                      const referenceApiUrl = `https://api.linkedin.com/rest/posts/${encodeURIComponent(referenceId)}`;
                      const referenceResponse = await axios.get(referenceApiUrl, {
                        headers: {
                          Authorization: `Bearer ${token}`,
                          'X-RestLi-Protocol-Version': '2.0.0',
                          'LinkedIn-Version': '202307',
                        },
                      });
                      creative.name = referenceResponse.data.adContext?.dscName || 'Unnamed Creative';
                    } catch (error) {
                      console.error(`Error fetching reference details for creative ${creative.id}:`, error);
                      creative.name = 'Unnamed Creative'; // Fallback if fetching reference fails
                    }
                  } else {
                    creative.name = 'Unnamed Creative'; // Default if neither headline nor reference is available
                  }

                  return creative;
                })
              );

              return campaign;
            } catch (error) {
              console.error(`Error fetching creatives for campaign ${campaign.id}:`, error);
              campaign.creatives = []; // Fallback to an empty array
              return campaign;
            }
          })
        );

        // Get existing data for the current ad account if it exists
        const existingCampaignGroups = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaignGroups || [];
        const existingBudget = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.budget || null;

        // Store the campaigns under the ad account ID key, preserving existing budget and groups
        adCampaigns[accountId] = {
          campaigns: campaignsWithCreatives,
          campaignGroups: existingCampaignGroups,
          budget: existingBudget,
        };
      } catch (error) {
        console.error(`Error fetching ad campaigns for accountId ${accountId}:`, error);
        adCampaigns[accountId] = {
          campaigns: existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaigns || [],
          campaignGroups: existingCampaignGroups, // Preserve existing data in case of error
          budget: existingBudget, // Preserve the existing budget
        };
      }
    }

    // Add empty arrays for any ad accounts that weren't processed
    user.adAccounts.forEach((account) => {
      const id = account.accountId;
      if (!adCampaigns.hasOwnProperty(id)) {
        adCampaigns[id] = {
          campaigns: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaigns || [],
          campaignGroups: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaignGroups || [],
          budget: existingAdCampaignsDoc?.adCampaigns?.[id]?.budget || null,
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






async function getUserAccessToken(userId) {
  const db = client.db('black-licorice');
  const user = await db.collection('users').findOne({ userId });
  if (!user || !user.accessToken) {
    console.warn(`No access token found for user ${userId}`);
    return null;
  }
  return user.accessToken;
}

// Fetch current campaigns from our database
async function fetchCurrentCampaignsFromDB(userId, accountId) {
  const db = client.db('black-licorice');
  const adCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });
  return adCampaignsDoc?.adCampaigns?.[accountId]?.campaigns || [];
}


async function fetchAdCampaigns(userId, accessToken, accountIds) {
  const db = client.db('black-licorice');
  const existingAdCampaignsDoc = await db.collection('adCampaigns').findOne({ userId });
  const adCampaigns = {};

  for (const accountId of accountIds) {
    const userAdAccountID = accountId.split(':').pop();
    const token = accessToken;

    const campaignsApiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

    let campaignsWithCreatives = [];
    let existingCampaignGroups = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaignGroups || [];
    let existingBudget = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.budget || null;

    try {
      // Fetch ad campaigns
      const response = await axios.get(campaignsApiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      });

      // Fetch creatives for each campaign
      campaignsWithCreatives = await Promise.all(
        response.data.elements.map(async (campaign) => {
          try {
            const campaignId = 'urn:li:sponsoredCampaign:' + campaign.id; 
            const creativesApiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/creatives?q=criteria&campaigns=List(${encodeURIComponent(campaignId)})&fields=id,isServing,content`;

            const creativesResponse = await axios.get(creativesApiUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-RestLi-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202406',
              },
            });

            // Process each creative
            campaign.creatives = await Promise.all(
              creativesResponse.data.elements.map(async (creative) => {
                if (creative.content?.textAd?.headline) {
                  creative.name = creative.content.textAd.headline;
                } else if (creative.content?.reference) {
                  const referenceId = creative.content.reference;
                  try {
                    const referenceApiUrl = `https://api.linkedin.com/rest/posts/${encodeURIComponent(referenceId)}`;
                    const referenceResponse = await axios.get(referenceApiUrl, {
                      headers: {
                        Authorization: `Bearer ${token}`,
                        'X-RestLi-Protocol-Version': '2.0.0',
                        'LinkedIn-Version': '202307',
                      },
                    });
                    creative.name = referenceResponse.data.adContext?.dscName || 'Unnamed Creative';
                  } catch (error) {
                    console.error(`Error fetching reference details for creative ${creative.id}:`, error);
                    creative.name = 'Unnamed Creative';
                  }
                } else {
                  creative.name = 'Unnamed Creative';
                }

                return creative;
              })
            );

            return campaign;
          } catch (error) {
            console.error(`Error fetching creatives for campaign ${campaign.id}:`, error);
            campaign.creatives = [];
            return campaign;
          }
        })
      );
    } catch (error) {
      // Check if it's a 401/403 due to invalid token
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        const newAccessToken = await refreshUserAccessToken(user.refreshToken);
        if (newAccessToken) {
          // Update the user's accessToken in DB if not already done in refreshUserAccessToken
          await db.collection('users').updateOne({ userId: user.userId }, { $set: { accessToken: newAccessToken } });
          // Retry your request with the newAccessToken
        } else {
          console.error(`Failed to refresh token for user ${user.userId}`);
          // Skip this user or handle accordingly
        }
      } else {
        // Some other error
        console.error('Some other error occurred:', error.message);
      }
      console.error(`Error fetching ad campaigns for accountId ${accountId}:`, error);
      // If error, fallback to existing data
      campaignsWithCreatives = existingAdCampaignsDoc?.adCampaigns?.[accountId]?.campaigns || [];
    }

    // Store fetched data or fallback data
    adCampaigns[accountId] = {
      campaigns: campaignsWithCreatives,
      campaignGroups: existingCampaignGroups,
      budget: existingBudget,
    };
  }

  // Ensure all user's accounts have data
  const userDoc = await db.collection('users').findOne({ userId });
  userDoc.adAccounts.forEach((account) => {
    const id = account.accountId;
    if (!adCampaigns.hasOwnProperty(id)) {
      adCampaigns[id] = {
        campaigns: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaigns || [],
        campaignGroups: existingAdCampaignsDoc?.adCampaigns?.[id]?.campaignGroups || [],
        budget: existingAdCampaignsDoc?.adCampaigns?.[id]?.budget || null,
      };
    }
  });

  return adCampaigns;
}


// Fetch LinkedIn campaigns from LinkedIn API
// async function fetchLinkedInCampaignsFromAPI(accountId, token) {
//   const apiUrl = `https://api.linkedin.com/rest/adAccounts/${accountId}/adCampaigns?q=search&sortOrder=DESCENDING`;

//   try {
//     const response = await axios.get(apiUrl, {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'X-RestLi-Protocol-Version': '2.0.0',
//         'LinkedIn-Version': '202406',
//       },
//     });
//     return response.data.elements || [];
//   } catch (error) {
//     console.error(`Error fetching LinkedIn campaigns for account ${accountId}:`, error);
//     return [];
//   }
// }

// // Save campaigns to our DB
// async function saveCampaignsToDB(userId, accountId, campaigns) {
//   const db = client.db('black-licorice');
//   // We assume adCampaigns structure is defined as { userId, adCampaigns: { [accountId]: { campaigns: [...] } } }
//   await db.collection('adCampaigns').updateOne(
//     { userId },
//     { $set: { [`adCampaigns.${accountId}.campaigns`]: campaigns } },
//     { upsert: true }
//   );
// }

// Save changes to DB
async function saveChangesToDB(userId, adAccountId, changes) {
  if (!adAccountId) {
    console.error("Error: adAccountId is undefined.");
    return;
  }

  const db = client.db('black-licorice');
  const collection = db.collection('changes');

  const changesWithIds = changes.map(change => ({
    ...change,
    _id: change._id ? new ObjectId(change._id) : new ObjectId(),
  }));

  const existingUserChanges = await collection.findOne({ userId });

  if (existingUserChanges) {
    const existingAdAccountChanges = existingUserChanges.changes[adAccountId] || [];

    const uniqueChanges = changesWithIds.filter(newChange =>
      !existingAdAccountChanges.some(existingChange =>
        (existingChange._id && existingChange._id.equals(newChange._id)) ||
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


// Function to fetch URN Information
async function fetchUrnInformation(urns, token) {
  // Similar logic to the front-end version, but now call the backend endpoints directly
  // Actually, since this is backend, you can call LinkedIn APIs directly here as well.
  // For each urnType/urnId, call your LinkedIn API logic and build up `urnInfoMap`.
  const urnInfoMap = {};

  for (const { urnType, urnId } of urns) {
    // build URL or handle logic similarly as on front end
    let name = await fetchUrnInfoBackend(token, urnType, urnId);
    urnInfoMap[`urn:li:${urnType}:${urnId}`] = name;
  }

  return urnInfoMap;
}

// Backend version of fetchUrnInfo
async function fetchUrnInfoBackend(token, urnType, urnId) {
  // Call the LinkedIn API to get targeting entity or adSegment data
  // Similar to the front-end logic, but no `document.cookie`, just use `token` directly
  let endpoint = `/api/linkedin/targeting-entities`; 
  // Actually call LinkedIn API directly here, since you're on server side
  // For example:
  if (urnType === 'adSegment') {
    const apiUrl = `https://api.linkedin.com/rest/adSegments/${urnId}`;
    try {
      const res = await axios.get(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-RestLi-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202406',
        },
      });
      return res.data.name || `Unknown (${urnType})`;
    } catch {
      return `Error (${urnType})`;
    }
  } else {
    const apiUrl = `https://api.linkedin.com/rest/adTargetingEntities?q=urns&urns=urn:li:${urnType}:${urnId}`;
    try {
      const res = await axios.get(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'LinkedIn-Version': '202406',
        },
      });
      const element = res.data.elements?.[0];
      return element?.name || `Unknown (${urnType})`;
    } catch {
      return `Error (${urnType})`;
    }
  }
}

// Backend function to fetch Campaign Group Name
async function fetchCampaignGroupNameBackend(token, accountId, groupId) {
  const userAdAccountID = accountId.split(':').pop();
  const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaignGroups/${groupId}`;

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    return response.data?.name || 'Unknown';
  } catch (error) {
    console.error('Error fetching campaign group name:', error.message);
    return 'Unknown';
  }
}

// A helper function to verify token validity and refresh if needed
async function verifyAndRefreshTokenIfNeeded(user) {
  if (!user.accessToken) {
    console.warn(`Access token missing for user ${user.userId}`);
    return null;
  }

  // Attempt a simple LinkedIn API call to verify token validity. 
  // For example, calling the "me" endpoint if available, or any cheap endpoint.
  const testUrl = 'https://api.linkedin.com/v2/me'; // This endpoint returns user details and requires a valid token

  try {
    const test = await axios.get(testUrl, {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202306', // or appropriate version
      },
      timeout: 5000 // just a small timeout
    });
    // If we get here, the token is valid
    return user.accessToken;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      // Token is invalid, attempt a refresh
      const newAccessToken = await refreshUserAccessToken(user.refreshToken);
      if (newAccessToken) {
        // Update DB with newAccessToken
        const db = client.db('black-licorice');
        await db.collection('users').updateOne({ userId: user.userId }, { $set: { accessToken: newAccessToken } });
        return newAccessToken;
      } else {
        console.error(`Failed to refresh token for user ${user.userId}`);
        return null;
      }
    } else {
      // Some other error occurred
      console.error('Error verifying token:', error.message);
      return null;
    }
  }
}

// The main function that runs in the cron job
async function checkForChangesForAllUsers() {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    const users = await usersCollection.find({}).toArray();

    for (const user of users) {
      const { userId, adAccounts } = user;

      // Verify and refresh token if needed
      const accessToken = await verifyAndRefreshTokenIfNeeded(user);
      if (!accessToken) {
        console.warn(`User ${userId} does not have a valid token, skipping...`);
        continue;
      }

      // Extract all the accountIds for this user
      const accountIds = adAccounts.map((a) => a.accountId);

      // 1. Fetch updated ad campaigns & creatives
      const adCampaigns = await fetchAdCampaigns(userId, accessToken, accountIds);

      // 2. Compare campaigns for each ad account and save differences
      for (const account of adAccounts) {
        const accountId = account.accountId;
        try {
          // Fetch current campaigns from DB
          const currentCampaigns = await fetchCurrentCampaignsFromDB(userId, accountId);

          // Get LinkedIn campaigns from adCampaigns object
          const linkedInCampaigns = adCampaigns[accountId]?.campaigns || [];

          const newDifferences = [];
          const urns = []; // Collect URNs here

          // Compare campaigns
          for (const campaign2 of linkedInCampaigns) {
            const campaign1 = currentCampaigns.find((c) => String(c.id) === String(campaign2.id));
            const changes = findDifferences(campaign1 || {}, campaign2, urns);

            if (Object.keys(changes).length > 0) {
              if (changes.campaignGroup) {
                const groupId = changes.campaignGroup.newValue?.split(':').pop();
                if (groupId) {
                  changes.campaignGroup.newValue = await fetchCampaignGroupNameBackend(accessToken, accountId, groupId);
                }
              }

              const difference = {
                campaign: campaign2.name,
                date: formatDate(new Date()),
                changes,
                notes: campaign2.notes || [],
                _id: campaign1 && campaign1._id ? new ObjectId(campaign1._id) : new ObjectId(),
              };
              newDifferences.push(difference);
            } else if (!campaign1) {
              // New campaign
              newDifferences.push({
                campaign: campaign2.name,
                date: formatDate(new Date()),
                changes: { message: 'New campaign added' },
                notes: [],
                _id: new ObjectId(),
              });
            }
          }

          // Fetch URN info if needed
          const uniqueUrns = Array.from(new Set(urns.map(JSON.stringify))).map(JSON.parse);
          const urnInfoMap = await fetchUrnInformation(uniqueUrns, accessToken);
          newDifferences.forEach((d) => (d.urnInfoMap = urnInfoMap));

          // Save the new differences
          await saveChangesToDB(userId, accountId, newDifferences);

        } catch (error) {
          console.error(`Error in checking changes for user ${userId}, account ${accountId}:`, error);
        }
      }

      // 3. After processing all accounts, save the updated adCampaigns back to DB
      await saveAdCampaignsToDB(userId, adCampaigns);
    }
  } catch (error) {
    console.error('Error in checkForChangesForAllUsers:', error);
  }
}

async function saveAdCampaignsToDB(userId, adCampaigns) {
  const db = client.db('black-licorice');
  await db.collection('adCampaigns').updateOne(
    { userId },
    { $set: { adCampaigns } },
    { upsert: true }
  );
}

// Now, in your cron setup:
cron.schedule('0 23 * * *', async () => { // runs every day at 2am for example
  console.log('Checking for changes for all users...');
  await checkForChangesForAllUsers();
  console.log('Done checking for changes for all users');
});














async function refreshUserAccessToken(refreshToken) {
  if (!refreshToken) {
    console.error('No refresh token provided');
    return null;
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const userId = decoded.userId;

    await client.connect();
    const db = client.db('black-licorice');
    const user = await db.collection('users').findOne({ userId });

    if (!user || user.refreshToken !== refreshToken) {
      console.error('Invalid or mismatched refresh token');
      return null;
    }

    const newAccessToken = jwt.sign(
      { userId: user.userId, linkedinId: user.linkedinId },
      process.env.LINKEDIN_CLIENT_SECRET,
      { expiresIn: '2h' }
    );

    // Optionally, you can also update the user's record in the database if needed
    // await db.collection('users').updateOne({ userId }, { $set: { accessToken: newAccessToken } });

    return newAccessToken;
  } catch (error) {
    console.error('Error refreshing token:', error.message);
    return null;
  }
}






const fetchAllChanges = async () => {
  try {
    const token = getTokenFromCookies();
    if (!token) {
      console.error('No authorization token found');
      return;
    }
    const response = await api.get('/api/get-all-changes', {
      params: { adAccountId: props.selectedAdAccountId },
      headers: { Authorization: `Bearer ${token}` },
      withCredentials: true
    });
    differences.value = response.data.reverse().map(change => {
      // Normalize _id to a string
      if (change._id && typeof change._id === 'object' && change._id.$oid) {
        change._id = change._id.$oid;
      } else if (typeof change._id === 'string') {
        // _id is already a string, do nothing
      } else if (!change._id) {
        change._id = ObjectID().toHexString();
      }
      if (!change.expandedChanges) {
        change.expandedChanges = {};
      }
      return change;
    });
  } catch (error) {
    console.error('Error fetching all changes from the database:', error);
  }
};





const checkForChanges = async () => {
  const token = getTokenFromCookies();
  if (!token) {
    console.error('No authorization token found');
    return;
  }

  const currentCampaigns = await fetchCurrentCampaigns();
  const linkedInCampaigns = await fetchLinkedInCampaigns();

  const newDifferences = [];
  const urns = []; // Collect URNs here

  for (const campaign2 of linkedInCampaigns) {
    const campaign1 = currentCampaigns.find((c) => String(c.id) === String(campaign2.id));

    if (campaign1) {
      const changes = findDifferences(campaign1, campaign2, urns);

      // If the change involves a campaign group, fetch its name
      if (changes.campaignGroup) {
        const accountId = campaign2.account.split(':').pop();
        const groupId = changes.campaignGroup.newValue?.split(':').pop();
        if (groupId) {
          changes.campaignGroup.newValue = await fetchCampaignGroupName(accountId, groupId);
        }
      }

      if (Object.keys(changes).length > 0) {
        newDifferences.push({
          campaign: campaign2.name,
          date: new Date().toLocaleDateString(),
          changes,
          notes: campaign2.notes || [],
          addingNote: false,
          _id: campaign1._id || ObjectID().toHexString(),
          expandedChanges: {},
          urnInfoMap: {}, // Will be filled after fetching URN info
        });
      }
    } else {
      // Handle new campaigns
      addNewChange({
        campaign: campaign2.name,
        date: new Date().toLocaleDateString(),
        changes: 'New campaign added',
        notes: campaign2.notes || [],
        addingNote: false,
        _id: campaign2._id || ObjectID().toHexString(),
        expandedChanges: {},
        urnInfoMap: {},
      });
    }
  }

  // Fetch URN information
  const uniqueUrns = Array.from(new Set(urns.map(JSON.stringify))).map(JSON.parse);
  const urnInfoMap = await fetchUrnInformation(uniqueUrns);

  // Attach urnInfoMap to each difference
  newDifferences.forEach((difference) => {
    difference.urnInfoMap = urnInfoMap;
  });

  // Filter and save differences
  const uniqueDifferences = newDifferences.filter((newDiff) => {
    return !differences.value.some((existingDiff) => {
      const isSameCampaign = existingDiff.campaign === newDiff.campaign;
      const isSameDate = existingDiff.date === newDiff.date;
      const isSameChanges =
        JSON.stringify(existingDiff.changes) === JSON.stringify(newDiff.changes);

      return isSameCampaign && isSameDate && isSameChanges;
    });
  });

  differences.value = [...uniqueDifferences, ...differences.value];

  try {
    await api.post(
      '/api/save-changes',
      { changes: uniqueDifferences.reverse(), adAccountId: props.selectedAdAccountId },
      {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      }
    );
  } catch (error) {
    console.error('Error saving changes:', error);
  }
};


async function fetchCurrentCampaigns() {
  if (!props.selectedAdAccountId) {
    console.warn('No selected Ad Account ID available');
    return [];
  }

  try {
    const token = getTokenFromCookies();
    if (!token) throw new Error("No authorization token found");

    const response = await api.get('/api/get-current-campaigns', {
      params: { accountId: props.selectedAdAccountId },
      headers: { Authorization: `Bearer ${token}` },
      withCredentials: true
    });
    const campaigns = response.data.campaigns || [];
    campaignsMap.value = campaigns.reduce((map, campaign) => {
      map[campaign.id] = campaign.name;
      return map;
    }, {});
    return campaigns;
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    return [];
  }
}

const fetchLinkedInCampaigns = async () => {
  const token = getTokenFromCookies();
  if (!token) {
    console.error("Authorization token missing");
    return [];
  }
  try {
    const response = await api.get('/api/linkedin/ad-campaigns', {
      params: { accountIds: [props.selectedAdAccountId] },
      headers: { Authorization: `Bearer ${token}` },
      withCredentials: true
    });
    return response.data.adCampaigns[props.selectedAdAccountId].campaigns || [];
  } catch (error) {
    console.error('Error fetching LinkedIn campaigns:', error);
    return [];
  }
};


const findDifferences = (obj1, obj2, urns = [], urnInfoMap = {}) => {
  const diffs = {};

  for (const key in obj1) {
    if (key === 'changeAuditStamps' || key === 'version' || key === 'campaignGroup') continue;

    if (Object.prototype.hasOwnProperty.call(obj2, key)) {
      const val1 = obj1[key];
      const val2 = obj2[key];

      // Handle targeting criteria (added/removed logic)
      if (key.startsWith('urn:li:adTargetingFacet:') && Array.isArray(val1) && Array.isArray(val2)) {
        const oldSet = new Set(val1);
        const newSet = new Set(val2);

        const removedItems = [...oldSet].filter((x) => !newSet.has(x));
        const addedItems = [...newSet].filter((x) => !oldSet.has(x));

        if (removedItems.length > 0 || addedItems.length > 0) {
          diffs[key] = {
            added: addedItems.map((v) => replaceUrnWithInfo(v, urnInfoMap)),
            removed: removedItems.map((v) => replaceUrnWithInfo(v, urnInfoMap)),
          };
          removedItems.forEach((item) => extractUrnsFromValue(item, urns));
          addedItems.forEach((item) => extractUrnsFromValue(item, urns));
        }
      }
      // Handle creatives
      else if (key === 'creatives' && Array.isArray(val1) && Array.isArray(val2)) {
        const creativeDiffs = [];

        // Map existing creatives by ID for easy comparison
        const creativeMap1 = val1.reduce((map, creative) => {
          map[creative.id] = creative;
          return map;
        }, {});
        const creativeMap2 = val2.reduce((map, creative) => {
          map[creative.id] = creative;
          return map;
        }, {});

        // Check for changes in `isServing` property
        for (const creativeId in creativeMap1) {
          if (
            creativeMap2[creativeId] &&
            creativeMap1[creativeId].isServing !== creativeMap2[creativeId].isServing
          ) {
            const name = creativeMap2[creativeId].name || 'Unnamed Creative';
            const newState = creativeMap2[creativeId].isServing;
            creativeDiffs.push({
              name,
              isServing: newState ? 'Set to: true' : 'Set to: false',
            });
          }
        }

        if (creativeDiffs.length > 0) {
          diffs[key] = creativeDiffs;
        }
      }
      // Recurse for nested objects
      else if (
        typeof val1 === 'object' &&
        typeof val2 === 'object' &&
        !(Array.isArray(val1) && Array.isArray(val2) && key.startsWith('urn:li:adTargetingFacet:'))
      ) {
        const nestedDiffs = findDifferences(val1, val2, urns, urnInfoMap);
        if (Object.keys(nestedDiffs).length > 0) {
          diffs[key] = nestedDiffs;
        }
      } else if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        diffs[key] = {
          oldValue: replaceUrnWithInfo(val1, urnInfoMap),
          newValue: replaceUrnWithInfo(val2, urnInfoMap),
        };
        extractUrnsFromValue(val1, urns);
        extractUrnsFromValue(val2, urns);
      }
    } else {
      diffs[key] = {
        oldValue: replaceUrnWithInfo(obj1[key], urnInfoMap),
        newValue: null,
      };
      extractUrnsFromValue(obj1[key], urns);
    }
  }

  for (const key in obj2) {
    if (!Object.prototype.hasOwnProperty.call(obj1, key)) {
      diffs[key] = {
        oldValue: null,
        newValue: replaceUrnWithInfo(obj2[key], urnInfoMap),
      };
      extractUrnsFromValue(obj2[key], urns);
    }
  }

  return diffs;
};

const fetchCampaignGroupName = async (accountId, groupId) => {
  try {
    const token = getTokenFromCookies();
    const response = await api.get('/api/linkedin/ad-campaign-group-name', {
      params: { accountId, groupId },
      headers: { Authorization: `Bearer ${token}` },
      withCredentials: true,
    });
    return response.data.name;
  } catch (error) {
    console.error('Error fetching campaign group name:', error);
    return 'Unknown';
  }
};


const addNewChange = (newChange) => {
  newChange._id = newChange._id || ObjectID().toHexString(); // Ensure _id is set
  newChange.expandedChanges = {}; // Initialize expandedChanges
  differences.value.push(newChange);
};

const extractUrnsFromValue = (value, urns) => {
  if (typeof value === 'string') {
    extractUrns(value, urns);
  } else if (Array.isArray(value)) {
    value.forEach((item) => extractUrnsFromValue(item, urns));
  } else if (typeof value === 'object' && value !== null) {
    for (const key in value) {
      extractUrnsFromValue(value[key], urns);
    }
  }
};

// const fetchUrnInformation = async (urns) => {
//   const urnInfoMap = {};
//   await Promise.all(
//     urns.map(async ({ urnType, urnId }) => {
//       const name = await fetchUrnInfo(urnType, urnId);
//       urnInfoMap[`urn:li:${urnType}:${urnId}`] = name;
//     })
//   );
//   return urnInfoMap;
// };

const replaceUrnWithInfo = (value, urnInfoMap) => {
  if (typeof value === 'string') {
    return urnInfoMap[value] || value; // Replace URN with mapped info or keep the original
  }
  return value;
};

const extractUrns = (value, urns = []) => {
  const urnPattern = /urn:li:([a-zA-Z]+):([^\s]+)/g;
  let match;
  while ((match = urnPattern.exec(value)) !== null) {
    urns.push({ urnType: match[1], urnId: match[2] });
  }
};