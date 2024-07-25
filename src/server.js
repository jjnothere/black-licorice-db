import express from 'express';
import axios from 'axios';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const url = 'mongodb+srv://jjnothere:GREATpoop^6^@black-licorice-cluster.5hb9ank.mongodb.net/?retryWrites=true&w=majority&appName=black-licorice-cluster';
const client = new MongoClient(url);
const SECRET_KEY = '10e9b23966ddb67730a76de7cbaa4f58b06f18a8d11d181888d4ee5b3412d06b';



const token = 'AQU1oNqFz2fKHe-A-XdXPHvjkOBbmKPJ9RRhAdAzKmWG-3sfKrscGgtxgpQRj3c3E7KGoD1FmXpqANLstB6rcO9rnKklfqYt9hQfdC7MdvDqOQuR96c4Qmf4fPeHbwxCW4Ay5d-l-v8WC-HC_hm0YJ9STIi6zVmhooBq8wPt-wKWhH3QGUuXANljVZxazsgA2N5vu_2ynjfRHG7YcPMnkAkdeqSFqlxJ-In5zrDO7kKdjjMrK4oP1GKFgO-mSzTSkEoqT55__MXv9E5xPVHUxyTdJ0rThtkBTp8YaxUMK1p2TyJOKY0PC54alqbvo5VI8orTd4rhRQt5aoHNbPdI-ms9sgMNiw';
// rf AQUcMDVwnfzMXs6_oRe67OxcrOhYrMrVco2vHh7mybvvWbxJ8LbWdN9evnnm0a5_DLlimngrbLWXjGoxlSPlx0AXsNhPbmMEztKUtgiBK3hp8qGNkZYeyY7ZlV0ljOmHZNxr-r8BIkOg5ARvmuUsUerWMkMzEFSTWtmvQnKf4f6YCn7vD7A1QmkXHr5ZjsvS7sCybreVSNAwBiCHC2BfZnCPWraIANlFqrFiNpnE5gKY7g73M-0CD9PMLLo5RR4SeBrgbeyb8OwjUESB7pMmlgNxrpOdzFG9K4dtWs_fGg46pZoAx_XSkPKwhYBjHWp4DG6Fy-5Grq0ccUR1YAf8Yyf0zkrhFw

// Initialize Express app
const app = express(); 
app.use(express.json());



// Enable CORS for development
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: 'http://localhost:5173' }));
}



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

async function authenticateToken(req, res, next) {
  const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];

  if (!token) return res.status(401).json({ message: 'Access Denied' });

  try {
    const verified = jwt.verify(token, SECRET_KEY);
    req.user = verified;

    await client.connect();
    const db = client.db('black-licorice');
    const user = await db.collection('users').findOne({ email: verified.email });

    if (!user) return res.status(404).json({ message: 'User not found' });

    req.userAdAccountID = user.accountId;
    next();
  } catch (error) {
    res.status(400).json({ message: 'Invalid Token' });
  }
}

app.get('/hello', async (req, res) => {
  await client.connect();
  const db = client.db('black-licorice');
  const items = await db.collection('items').find({}).toArray();
  res.send(items);
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
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');
    
    const email = req.user.email;
    
    const user = await usersCollection.findOne({ email }, { projection: { _id: 0, email: 1, accountId: 1 } });
    
    if (user) {
      res.status(200).json(user);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    console.error('Error fetching user profile:', error);
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
    const token = jwt.sign({ email: newUser.email, userId: newUser.userId }, SECRET_KEY, { expiresIn: '1h' });
    
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
  const { email, password } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ email: user.email, userId: user.userId }, SECRET_KEY, { expiresIn: '1h' });

    res.json({ token });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Get campaigns for the logged-in user
app.get('/get-current-campaigns', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const userCampaigns = await db.collection('campaigns').findOne({ userId });

    res.json(userCampaigns || { elements: [] });
  } catch (error) {
    console.error('Error fetching current campaigns from database:', error);
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
  const { changes } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    // Add an _id to each change if it doesn't have one
    const changesWithIds = changes.map(change => {
      if (!change._id) {
        change._id = new ObjectId();
      } else {
        change._id = new ObjectId(change._id); // Ensure _id is of type ObjectId
      }
      return change;
    });

    const existingUserChanges = await changesCollection.findOne({ userId });

    if (existingUserChanges) {
      // Only add unique changes
      const uniqueChanges = changesWithIds.filter(newChange => 
        !existingUserChanges.changes.some(existingChange => 
          existingChange._id.equals(newChange._id) || 
          (existingChange.campaign === newChange.campaign && 
          existingChange.date === newChange.date && 
          existingChange.changes === newChange.changes)
        )
      );

      if (uniqueChanges.length > 0) {
        await changesCollection.updateOne(
          { userId },
          { $push: { changes: { $each: uniqueChanges } } }
        );
      }
    } else {
      await changesCollection.insertOne({
        userId,
        changes: changesWithIds,
      });
    }
    res.send('Changes saved successfully');
  } catch (error) {
    console.error('Error saving changes to MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Add Note Endpoint
app.post('/add-note', authenticateToken, async (req, res) => {
  const { changeId, newNote } = req.body;
  const note = { _id: new ObjectId(), note: newNote, timestamp: new Date().toISOString() };

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const result = await db.collection('changes').updateOne(
      { "changes._id": new ObjectId(changeId) },
      { $push: { 'changes.$.notes': note } }
    );

    if (result.matchedCount === 0) {
      res.status(404).send('Document not found');
    } else {
      res.send('Note added successfully');
    }
  } catch (error) {
    console.error('Error adding note to MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Edit Note Endpoint
app.post('/edit-note', authenticateToken, async (req, res) => {
  const { changeId, noteId, updatedNote } = req.body;


  try {
    await client.connect();
    const db = client.db('black-licorice');

    const result = await db.collection('changes').updateOne(
      { "changes._id": new ObjectId(changeId), "changes.notes._id": new ObjectId(noteId) },
      { 
        $set: { 
          "changes.$[changeElem].notes.$[noteElem].note": updatedNote,
          "changes.$[changeElem].notes.$[noteElem].timestamp": new Date().toISOString()
        } 
      },
      {
        arrayFilters: [
          { "changeElem._id": new ObjectId(changeId) },
          { "noteElem._id": new ObjectId(noteId) }
        ]
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).send('Document not found');
    } else {
      res.send('Note updated successfully');
    }
  } catch (error) {
    console.error('Error updating note in MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Delete Note Endpoint
app.post('/delete-note', authenticateToken, async (req, res) => {
  const { changeId, noteId } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');

    const result = await db.collection('changes').updateOne(
      { "changes._id": new ObjectId(changeId) },
      { $pull: { "changes.$.notes": { _id: new ObjectId(noteId) } } }
    );

    if (result.matchedCount === 0) {
      res.status(404).send('Document not found');
    } else {
      res.send('Note deleted successfully');
    }
  } catch (error) {
    console.error('Error deleting note from MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/get-all-changes', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const userChanges = await db.collection('changes').findOne({ userId });

    if (userChanges) {
      res.json(userChanges.changes);
    } else {
      res.json([]); // Return an empty array if no changes are found
    }
  } catch (error) {
    console.error('Error fetching changes from MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/save-campaigns', authenticateToken, async (req, res) => {
  const { campaigns } = req.body;
  const userId = req.user.userId;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const collection = db.collection('campaigns');

    // Check if a document for the user already exists
    const existingDoc = await collection.findOne({ userId });

    if (existingDoc) {
      // Update the existing document
      await collection.updateOne(
        { userId },
        { $set: { elements: campaigns } }
      );
      res.send('Campaigns updated successfully');
    } else {
      // Insert a new document
      await collection.insertOne({ userId, elements: campaigns });
      res.send('Campaigns saved successfully');
    }
  } catch (error) {
    console.error('Error saving campaigns to MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/linkedin', authenticateToken, async (req, res) => {
  const { start, end, campaigns } = req.query;

  const startDate = new Date(start);
  const endDate = new Date(end);
  const userAdAccountID = req.userAdAccountID;

  let url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:${startDate.getFullYear()},month:${startDate.getMonth() + 1},day:${startDate.getDate()}),end:(year:${endDate.getFullYear()},month:${endDate.getMonth() + 1},day:${endDate.getDate()}))&timeGranularity=DAILY&pivot=CAMPAIGN&accounts=List(urn%3Ali%3AsponsoredAccount%3A${userAdAccountID})&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues`;

  if (campaigns) {
    url += `&campaigns=${campaigns}`;
  }

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching data from LinkedIn API:', error);
    res.status(error.response ? error.response.status : 500).send(error.message);
  }
});

app.get('/ad-account-name', authenticateToken, async (req, res) => {
  const userAdAccountID = req.userAdAccountID;
  const url = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    const adAccountName = response.data.name;
    res.json({ name: adAccountName });
  } catch (error) {
    console.error('Error fetching ad account name from LinkedIn API:', error);
    res.status(error.response ? error.response.status : 500).send(error.message);
  }
});

app.get('/linkedin/ad-campaigns', authenticateToken, async (req, res) => {
  const userAdAccountID = req.userAdAccountID;

  const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaigns?q=search&sortOrder=DESCENDING`;

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    res.json(response.data); // Make sure to return the data as JSON
  } catch (error) {
    console.error('Error fetching data from LinkedIn API:', error);
    res.status(error.response ? error.response.status : 500).send(error.message);
  }
});


app.get('/get-all-changes', async (req, res) => {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const allChanges = await db.collection('changes').find({}).toArray();
    res.json(allChanges);
  } catch (error) {
    console.error('Error fetching all changes from database:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/linkedin/ad-campaign-groups', async (req, res) => {
  const apiUrl = `https://api.linkedin.com/rest/adAccounts/${userAdAccountID}/adCampaignGroups?q=search&search=(status:(values:List(ACTIVE,ARCHIVED,CANCELED,DRAFT,PAUSED,PENDING_DELETION,REMOVED)))&sortOrder=DESCENDING`;

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202406',
      },
    });
    res.json(response.data); // Make sure to return the data as JSON
  } catch (error) {
    console.error('Error fetching data from LinkedIn API:', error);
    res.status(error.response ? error.response.status : 500).send(error.message);
  }
});

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Start the server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
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