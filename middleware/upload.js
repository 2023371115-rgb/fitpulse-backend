const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { VALID_WORKSPACE } = require('./workspace');

const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const workspaceId = req.params.workspaceId || 'default';
    const destRoot = path.resolve(UPLOADS_ROOT, workspaceId);
    // Segunda barrera (la primera es middleware/workspace.js): nunca escribir fuera de uploads/
    if (!VALID_WORKSPACE.test(workspaceId) || !destRoot.startsWith(UPLOADS_ROOT + path.sep)) {
      return cb(Object.assign(new Error('Espacio de trabajo no valido'), { status: 400 }));
    }
    ensureDir(destRoot);
    cb(null, destRoot);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf', 'audio/mpeg', 'audio/wav', 'video/mp4'
  ];
  cb(null, allowed.includes(file.mimetype));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
});

module.exports = upload.single('file');
