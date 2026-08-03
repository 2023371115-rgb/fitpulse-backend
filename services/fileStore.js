const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'files.json');

function ensureStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]');
}

function readFiles() {
  ensureStore();
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

function writeFiles(files) {
  ensureStore();
  fs.writeFileSync(dataFile, JSON.stringify(files, null, 2));
}

function listFiles(workspaceId) {
  return readFiles()
    .filter(file => file.workspace_id === workspaceId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 100);
}

function addFile(file) {
  const files = readFiles();
  const record = {
    id: uuidv4(),
    created_at: new Date().toISOString(),
    metadata: {},
    ...file
  };
  files.unshift(record);
  writeFiles(files);
  return record;
}

module.exports = { listFiles, addFile };
