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

app.post('/update-notes', async (req, res) => {
  const { id, newNote } = req.body;
  const note = { note: newNote, timestamp: new Date().toISOString() };

  await client.connect();
  const db = client.db('black-licorice');
  await db.collection('items').updateOne(
    { _id: new ObjectId(id) },
    { $push: { historyNotes: note } }
  );
  res.send('Note added successfully');
});

app.post('/edit-note', async (req, res) => {
  const { id, noteIndex, updatedNote } = req.body;

  await client.connect();
  const db = client.db('black-licorice');
  const item = await db.collection('items').findOne({ _id: new ObjectId(id) });
  item.historyNotes[noteIndex].note = updatedNote;
  item.historyNotes[noteIndex].timestamp = new Date().toISOString();

  await db.collection('items').updateOne(
    { _id: new ObjectId(id) },
    { $set: { historyNotes: item.historyNotes } }
  );
  res.send('Note updated successfully');
});

app.post('/delete-note', async (req, res) => {
  const { id, noteIndex } = req.body;

  await client.connect();
  const db = client.db('black-licorice');
  const item = await db.collection('items').findOne({ _id: new ObjectId(id) });
  item.historyNotes.splice(noteIndex, 1);

  await db.collection('items').updateOne(
    { _id: new ObjectId(id) },
    { $set: { historyNotes: item.historyNotes } }
  );
  res.send('Note deleted successfully');
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