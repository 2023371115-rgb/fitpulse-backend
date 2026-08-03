const express = require('express');
const { externalSearch } = require('../services/externalSearch');

const router = express.Router();

router.get('/external', async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  const type = (req.query.type || 'web').toString();
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const results = await externalSearch(query, { type });
    return res.json(results);
  } catch (err) {
    console.error('External search failed:', err?.message || err);
    return res.status(500).json({ error: 'External search failed', details: err?.message || String(err) });
  }
});

module.exports = router;
