import express from 'express';
const axios = require('axios');
import { MongoClient, ObjectId } from 'mongodb';

const url = 'mongodb+srv://jjnothere:GREATpoop^6^@black-licorice-cluster.5hb9ank.mongodb.net/?retryWrites=true&w=majority&appName=black-licorice-cluster';
const client = new MongoClient(url);

const app = express();
app.use(express.json());

app.get('/hello', async (req, res) => {
  await client.connect();
  const db = client.db('black-licorice');
  const items = await db.collection('items').find({}).toArray();
  res.send(items);
});

app.get('/get-current-campaigns', async (req, res) => {
  try {
    await client.connect();
    const db = client.db('black-licorice');
    const currentCampaigns = await db.collection('campaigns').findOne({});
    res.json(currentCampaigns || { elements: [] });
  } catch (error) {
    console.error('Error fetching current campaigns from database:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/save-campaigns', async (req, res) => {
  const { campaigns } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const collection = db.collection('campaigns');

    const existingDoc = await collection.findOne({});

    if (existingDoc) {
      await collection.updateOne(
        { _id: existingDoc._id },
        { $set: { elements: campaigns.elements } }
      );
      res.send('Campaigns updated successfully');
    } else {
      await collection.insertOne({ elements: campaigns.elements });
      res.send('Campaigns saved successfully');
    }
  } catch (error) {
    console.error('Error saving campaigns to MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/save-changes', async (req, res) => {
  const { changes } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const changesCollection = db.collection('changes');

    for (const change of changes) {
      await changesCollection.insertOne({
        campaign: change.campaign,
        date: change.date,
        changes: change.changes,
        notes: change.notes || [],
      });
    }

    res.send('Changes saved successfully');
  } catch (error) {
    console.error('Error saving changes to MongoDB:', error);
    res.status(500).send('Internal Server Error');
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

app.post('/update-notes', async (req, res) => {
  const { id, newNote } = req.body;
  const note = { note: newNote, timestamp: new Date().toISOString() };

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const result = await db.collection('changes').updateOne(
      { _id: new ObjectId(id) },
      { $push: { notes: note } }
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

app.post('/edit-note', async (req, res) => {
  const { id, noteIndex, updatedNote } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const change = await db.collection('changes').findOne({ _id: new ObjectId(id) });
    if (!change) {
      res.status(404).send('Document not found');
      return;
    }
    change.notes[noteIndex].note = updatedNote;
    change.notes[noteIndex].timestamp = new Date().toISOString();

    await db.collection('changes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { notes: change.notes } }
    );
    res.send('Note updated successfully');
  } catch (error) {
    console.error('Error updating note in MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/delete-note', async (req, res) => {
  const { id, noteIndex } = req.body;

  try {
    await client.connect();
    const db = client.db('black-licorice');
    const change = await db.collection('changes').findOne({ _id: new ObjectId(id) });
    if (!change) {
      res.status(404).send('Document not found');
      return;
    }
    change.notes.splice(noteIndex, 1);

    await db.collection('changes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { notes: change.notes } }
    );
    res.send('Note deleted successfully');
  } catch (error) {
    console.error('Error deleting note from MongoDB:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/linkedin', async (req, res) => {
  const { start, end, campaigns } = req.query;
  
  const startDate = new Date(start);
  const endDate = new Date(end);

  let url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:${startDate.getFullYear()},month:${startDate.getMonth() + 1},day:${startDate.getDate()}),end:(year:${endDate.getFullYear()},month:${endDate.getMonth() + 1},day:${endDate.getDate()}))&timeGranularity=DAILY&pivot=CAMPAIGN&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues`;

  if (campaigns) {
    url += `&campaigns=${campaigns}`;
  }

  const token = 'AQV_sv7464y5sYabV-HsMa9Pn3LPLlP9FwU7Ipu4uQH4Mvc6CgTfcLh2PC26WbI_nscTNnOmSiokgemWAlXG5i-ryx3OLkDMt3IkPG0mlXI6MJDHDlac8bvVjez8iaE3e2VA6xF3eg3aND4b9XrzlPwMU9xXOXHrgxY78dztAUS51ty1LDDc8_zbbmYWtTodY1FruLbvWJrzX2O5cOspK28pMpNAVj348MIitHCNy3bfS4XhjumFcpY8apapvTSyFF__5GVJswxdLzLxcT-CE2cRlenSPKjw4HcMvYgcvO4Glx0Dt_RtPfUmdTEty7vq2KbnQNCiNIQ2ZSbLAdcP8xo0u_lCAg';

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

app.get('/ad-account-name', async (req, res) => {
  const url = 'https://api.linkedin.com/rest/adAccounts/512388408';
  const token = 'AQV_sv7464y5sYabV-HsMa9Pn3LPLlP9FwU7Ipu4uQH4Mvc6CgTfcLh2PC26WbI_nscTNnOmSiokgemWAlXG5i-ryx3OLkDMt3IkPG0mlXI6MJDHDlac8bvVjez8iaE3e2VA6xF3eg3aND4b9XrzlPwMU9xXOXHrgxY78dztAUS51ty1LDDc8_zbbmYWtTodY1FruLbvWJrzX2O5cOspK28pMpNAVj348MIitHCNy3bfS4XhjumFcpY8apapvTSyFF__5GVJswxdLzLxcT-CE2cRlenSPKjw4HcMvYgcvO4Glx0Dt_RtPfUmdTEty7vq2KbnQNCiNIQ2ZSbLAdcP8xo0u_lCAg';

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

app.get('/linkedin/ad-campaigns', async (req, res) => {
  const apiUrl = 'https://api.linkedin.com/rest/adAccounts/512388408/adCampaigns?q=search&sortOrder=DESCENDING';
  const token = 'AQV_sv7464y5sYabV-HsMa9Pn3LPLlP9FwU7Ipu4uQH4Mvc6CgTfcLh2PC26WbI_nscTNnOmSiokgemWAlXG5i-ryx3OLkDMt3IkPG0mlXI6MJDHDlac8bvVjez8iaE3e2VA6xF3eg3aND4b9XrzlPwMU9xXOXHrgxY78dztAUS51ty1LDDc8_zbbmYWtTodY1FruLbvWJrzX2O5cOspK28pMpNAVj348MIitHCNy3bfS4XhjumFcpY8apapvTSyFF__5GVJswxdLzLxcT-CE2cRlenSPKjw4HcMvYgcvO4Glx0Dt_RtPfUmdTEty7vq2KbnQNCiNIQ2ZSbLAdcP8xo0u_lCAg';

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

app.get('/linkedin/ad-campaign-groups', async (req, res) => {
  const apiUrl = 'https://api.linkedin.com/rest/adAccounts/512388408/adCampaignGroups?q=search&search=(status:(values:List(ACTIVE,ARCHIVED,CANCELED,DRAFT,PAUSED,PENDING_DELETION,REMOVED)))&sortOrder=DESCENDING';
  const token = 'AQV_sv7464y5sYabV-HsMa9Pn3LPLlP9FwU7Ipu4uQH4Mvc6CgTfcLh2PC26WbI_nscTNnOmSiokgemWAlXG5i-ryx3OLkDMt3IkPG0mlXI6MJDHDlac8bvVjez8iaE3e2VA6xF3eg3aND4b9XrzlPwMU9xXOXHrgxY78dztAUS51ty1LDDc8_zbbmYWtTodY1FruLbvWJrzX2O5cOspK28pMpNAVj348MIitHCNy3bfS4XhjumFcpY8apapvTSyFF__5GVJswxdLzLxcT-CE2cRlenSPKjw4HcMvYgcvO4Glx0Dt_RtPfUmdTEty7vq2KbnQNCiNIQ2ZSbLAdcP8xo0u_lCAg';

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

app.listen(8000, () => {
  console.log('Server is listening on port 8000');
});


// https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CREATIVE&timeGranularity=DAILY&dateRange=(start:(year:2024,month:6,day:1))&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446)

// https://api.linkedin.com/rest/adAnalytics?q=statistics&pivots=CREATIVE&dateRange=(start:(year:2024,month:6,day:1))&timeGranularity=DAILY&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446)

// https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2023,month:6,day:1),end:(year:2024,month:9,day:30))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&pivot=COMPANY&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues


// https://api.linkedin.com/rest/adAccounts/512388408/adCampaigns?q=search&search=(type:(values:List(SPONSORED_UPDATES)),status:(values:List(ACTIVE)))&sortOrder=DESCENDING



// List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)

// https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2024,month:6,day:1),end:(year:2024,month:6,day:24))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)&pivot=CAMPAIGN&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions
// Newest https://api.linkedin.com/rest/adAnalytics?q=analytics&dateRange=(start:(year:2024,month:6,day:1),end:(year:2024,month:6,day:24))&timeGranularity=MONTHLY&accounts=List(urn%3Ali%3AsponsoredAccount%3A512388408)&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A314706446,urn%3Ali%3AsponsoredCampaign%3A320888526,urn%3Ali%3AsponsoredCampaign%3A320931536)&pivot=CAMPAIGN&fields=externalWebsiteConversions,dateRange,impressions,landingPageClicks,likes,shares,costInLocalCurrency,approximateUniqueImpressions,pivotValues