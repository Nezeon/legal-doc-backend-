// server.js
// Express backend with file upload + Firestore integration + Firebase Auth

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const verifyToken = require('./middleware/auth');

// Load .env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ----- Firebase Admin Init (robust) -----
// Support two modes:
// 1) Provide FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env
//    (note: private key must be escaped with literal "\n" sequences)
// 2) Provide FIREBASE_SERVICE_ACCOUNT_PATH pointing to a service account JSON file
// If neither is present or init fails, the server will fall back to a local metadata store
let db = null;
const COLLECTION = 'documents';

function loadServiceAccountFromPath(p) {
  try {
    const full = path.isAbsolute(p) ? p : path.join(__dirname, p);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load service account from path:', e.message);
    return null;
  }
}

try {
  let cred = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    cred = loadServiceAccountFromPath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }

  if (!cred && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
    // Ensure we don't call replace() on undefined
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;
    // Remove wrapping quotes if present, then normalize escaped newlines
    let normalizedKey = rawKey;
    if (typeof normalizedKey === 'string') {
      // strip leading/trailing single or double quotes
      normalizedKey = normalizedKey.replace(/^['"]|['"]$/g, '');
      normalizedKey = normalizedKey.replace(/\\n/g, '\n');
    }
    cred = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: normalizedKey,
    };
  }

  if (cred) {
    // firebase-admin expects keys named like in service account JSON
    const cert = {
      projectId: cred.project_id || cred.projectId || process.env.FIREBASE_PROJECT_ID,
      clientEmail: cred.client_email || cred.clientEmail || process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: cred.private_key || cred.privateKey || (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };

    admin.initializeApp({
      credential: admin.credential.cert(cert),
    });
    db = admin.firestore();
    console.log('✅ Firebase initialized.');
  } else {
    console.warn('⚠️ Firebase credentials not found. Falling back to local metadata store.');
  }
} catch (err) {
  console.warn('⚠️ Firebase initialization failed, running without Firestore:', err && err.message ? err.message : err);
  db = null;
}

// ...local metadata helpers are defined later (after UPLOAD_DIR)

// ----- Config -----
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Allowed file extensions + MIME types
const ALLOWED_EXTS = new Set(['.pdf', '.docx', '.txt']);
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

// Ensure /uploads exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Local metadata file (used when Firestore isn't available)
const LOCAL_METADATA = path.join(UPLOAD_DIR, 'local_metadata.json');

function readLocalMetadata() {
  try {
    if (!fs.existsSync(LOCAL_METADATA)) return [];
    const raw = fs.readFileSync(LOCAL_METADATA, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.warn('Failed to read local metadata:', e.message);
    return [];
  }
}

function writeLocalMetadata(arr) {
  try {
    fs.writeFileSync(LOCAL_METADATA, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to write local metadata:', e.message);
  }
}

// Middleware
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR)); // optional (dev only)

// ----- Multer setup -----
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `upload-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const isExtOk = ALLOWED_EXTS.has(ext);
    const isMimeOk = ALLOWED_MIME.has(file.mimetype);
    if (isExtOk && isMimeOk) cb(null, true);
    else cb(new Error('INVALID_FILE_TYPE'));
  },
});

// ----- Routes -----

// Protect upload route (only logged-in users can upload)
app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Metadata with user association
    const docData = {
      userId: req.user.uid,              // 🔹 associate with user
      userEmail: req.user.email,         // Optional: store user email too
      fileName: req.file.filename,
      originalName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      filePath: req.file.path,
      status: 'uploaded',
      uploadedAt: FieldValue.serverTimestamp(),
    };

    if (db) {
      const docRef = await db.collection(COLLECTION).add(docData);
      return res.status(201).json({
        success: true,
        message: 'File uploaded & metadata saved to Firestore',
        id: docRef.id,
        data: docData,
      });
    } else {
      // Save to local metadata file
      const all = readLocalMetadata();
      const id = `local-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      all.unshift({ id, ...docData });
      writeLocalMetadata(all);
      return res.status(201).json({
        success: true,
        message: 'File uploaded & metadata saved locally',
        id,
        data: docData,
      });
    }
  } catch (err) {
    console.error('Upload error:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Upload failed' });
  }
});

// List documents (protected - only user's own documents)
app.get('/api/documents', verifyToken, async (req, res) => {
  try {
    if (db) {
      const snapshot = await db
        .collection(COLLECTION)
        .where('userId', '==', req.user.uid)  // 🔹 Filter by user ID
        .orderBy('uploadedAt', 'desc')
        .get();
      const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      return res.json({ success: true, documents: docs });
    } else {
      const docs = readLocalMetadata();
      // Filter by user ID for local storage too
      const userDocs = docs.filter(doc => doc.userId === req.user.uid);
      return res.json({ success: true, documents: userDocs });
    }
  } catch (err) {
    console.error('List error:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to list documents' });
  }
});

// Get document by ID (protected - only owner can access)
app.get('/api/documents/:id', verifyToken, async (req, res) => {
  try {
    if (db) {
      const docRef = db.collection(COLLECTION).doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res
          .status(404)
          .json({ success: false, message: 'Document not found' });
      }

      const docData = doc.data();
      // Check if the document belongs to the requesting user
      if (docData.userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      return res.json({ success: true, id: doc.id, data: docData });
    } else {
      const docs = readLocalMetadata();
      const found = docs.find((d) => d.id === req.params.id);
      if (!found) {
        return res
          .status(404)
          .json({ success: false, message: 'Document not found' });
      }
      
      // Check ownership for local storage too
      if (found.userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      return res.json({ success: true, id: found.id, data: found });
    }
  } catch (err) {
    console.error('Fetch error:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to fetch document' });
  }
});

// Update status (protected - only owner can update)
app.patch('/api/documents/:id/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing status value' });
    }

    if (db) {
      const docRef = db.collection(COLLECTION).doc(req.params.id);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        return res
          .status(404)
          .json({ success: false, message: 'Document not found' });
      }

      // Check ownership
      if (doc.data().userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      await docRef.update({ status });
      return res.json({ success: true, message: 'Status updated' });
    } else {
      const docs = readLocalMetadata();
      const idx = docs.findIndex((d) => d.id === req.params.id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Document not found' });
      }
      
      // Check ownership
      if (docs[idx].userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      docs[idx].status = status;
      writeLocalMetadata(docs);
      return res.json({ success: true, message: 'Status updated locally' });
    }
  } catch (err) {
    console.error('Update error:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to update status' });
  }
});

// Delete document (protected - only owner can delete)
app.delete('/api/documents/:id', verifyToken, async (req, res) => {
  try {
    if (db) {
      const docRef = db.collection(COLLECTION).doc(req.params.id);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        return res
          .status(404)
          .json({ success: false, message: 'Document not found' });
      }

      // Check ownership
      if (doc.data().userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      // Optional: Delete the physical file too
      const filePath = doc.data().filePath;
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await docRef.delete();
      return res.json({ success: true, message: 'Document deleted' });
    } else {
      const docs = readLocalMetadata();
      const idx = docs.findIndex((d) => d.id === req.params.id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Document not found' });
      }
      
      // Check ownership
      if (docs[idx].userId !== req.user.uid) {
        return res
          .status(403)
          .json({ success: false, message: 'Access denied' });
      }

      // Optional: Delete the physical file
      const filePath = docs[idx].filePath;
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      const filtered = docs.filter((d) => d.id !== req.params.id);
      writeLocalMetadata(filtered);
      return res.json({ success: true, message: 'Document deleted locally' });
    }
  } catch (err) {
    console.error('Delete error:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to delete document' });
  }
});

// Get user profile (protected)
app.get('/api/user/profile', verifyToken, (req, res) => {
  res.json({
    success: true,
    user: {
      uid: req.user.uid,
      email: req.user.email,
      emailVerified: req.user.emailVerified,
      name: req.user.name,
      picture: req.user.picture
    }
  });
});

// Health check (public)
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Server healthy', firebase: !!db });
});

// Public route to check server status (no auth required)
app.get('/api/status', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API is running',
    firebase: !!db,
    timestamp: new Date().toISOString()
  });
});

// ----- Error Handler -----
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res
      .status(413)
      .json({ success: false, message: 'File too large. Max 10 MB' });
  }
  if (err && err.message === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      message: 'Invalid file type. Only PDF, DOCX, and TXT allowed.',
    });
  }
  console.error('General error:', err);
  return res
    .status(500)
    .json({ success: false, message: 'Unexpected server error' });
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log('POST files to /api/upload using form field name "file" (Auth required)');
  console.log('Include Authorization: Bearer <firebase-id-token> header for protected routes');
});