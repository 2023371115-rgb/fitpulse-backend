const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const upload = require('../middleware/upload');
const { genImageThumb } = require('../services/thumb');
const { query } = require('../db');
const fileStore = require('../services/fileStore');

const router = express.Router({ mergeParams: true });

// GET /api/workspaces/:workspaceId/files
router.get('/', async (req, res) => {
  const workspaceId = req.params.workspaceId || 'default';
  try {
    const rows = await query('SELECT id, workspace_id, original_name, filename, mime_type, size, storage_path, thumbnail_url, metadata, created_at FROM files WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100', [workspaceId]);
    return res.json(rows.rows.map(r => ({
      id: r.id,
      workspace_id: r.workspace_id,
      original_name: r.original_name,
      filename: r.filename,
      mime_type: r.mime_type,
      size: r.size,
      storage_path: r.storage_path,
      thumbnail_url: r.thumbnail_url,
      metadata: r.metadata,
      created_at: r.created_at
    })));
  } catch (err) {
    console.warn('Postgres unavailable; using local file store for list:', err.message);
    return res.json(fileStore.listFiles(workspaceId));
  }
});

// POST /api/workspaces/:workspaceId/files
router.post('/', upload, async (req,res)=>{
  try{
    const f = req.file;
    if(!f) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

    const workspaceId = req.params.workspaceId || 'default';

    const metadata = {
      original_name: f.originalname,
      filename: f.filename,
      mime_type: f.mimetype,
      size: f.size,
      storage_path: `/uploads/${workspaceId}/${f.filename}`,
      workspace_id: workspaceId,
      owner_id: req.user ? req.user.id : null,
      created_at: new Date().toISOString()
    };

    let thumbnailUrl = null;
    if(f.mimetype.startsWith('image/')){
      const uploadsDir = path.join(__dirname,'..','uploads', workspaceId);
      const thumbsDir = path.join(uploadsDir, 'thumbs');
      const thumbPath = await genImageThumb(path.join(uploadsDir, f.filename), thumbsDir, 400);
      thumbnailUrl = `/uploads/${workspaceId}/thumbs/${path.basename(thumbPath)}`;
    }

    const record = {
      id: uuidv4(),
      ...metadata,
      thumbnail_url: thumbnailUrl
    };

    try {
      const insertText = `INSERT INTO files(id, workspace_id, original_name, filename, mime_type, size, storage_path, thumbnail_url, metadata)
                          VALUES(?,?,?,?,?,?,?,?,?)`;
      const insertValues = [
        record.id,
        record.workspace_id,
        record.original_name,
        record.filename,
        record.mime_type,
        record.size,
        record.storage_path,
        record.thumbnail_url,
        JSON.stringify({})
      ];

      await query(insertText, insertValues);

      return res.status(201).json({ file: { ...record, created_at: new Date().toISOString() } });
    } catch (dbErr) {
      console.warn('Database unavailable; saving upload metadata locally:', dbErr.message);
      return res.status(201).json({ file: fileStore.addFile(record) });
    }
  }catch(err){
    console.error(err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

module.exports = router;
