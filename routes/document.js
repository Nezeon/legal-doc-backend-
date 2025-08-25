// routes/documents.js
// Routes for managing uploaded documents metadata in Firestore

const express = require('express');
const router = express.Router();
const db = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const COLLECTION = 'documents';

// Helper: sanitize input
function sanitizeFileMeta(file) {
  return {
    fileName: String(file.filename || ''),
    originalName: String(file.originalname || ''),
    fileType: String(file.mimetype || ''),
    fileSize: Number(file.size || 0),
    filePath: String(file.path || ''),
    status: 'uploaded', // default
    uploadedAt: FieldValue.serverTimestamp(),
  };
}

// 1) Save new document metadata (called after successful upload)
router.post('/', async (req, res) => {
  try {
    const { filename, originalname, mimetype, size, path } = req.body;

    if (!filename || !mimetype) {
      return res.status(400).json({ success: false, message: 'Missing required file metadata' });
    }

    const docData = sanitizeFileMeta({ filename, originalname, mimetype, size, path });
    const docRef = await db.collection(COLLECTION).add(docData);

    return res.status(201).json({ success: true, id: docRef.id, data: docData });
  } catch (err) {
    console.error('Error saving doc:', err);
    return res.status(500).json({ success: false, message: 'Failed to save document metadata' });
  }
});

// 2) List all documents
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).orderBy('uploadedAt', 'desc').get();
    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, documents: docs });
  } catch (err) {
    console.error('Error listing docs:', err);
    return res.status(500).json({ success: false, message: 'Failed to list documents' });
  }
});

// 3) Get document by ID
router.get('/:id', async (req, res) => {
  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    return res.json({ success: true, id: doc.id, data: doc.data() });
  } catch (err) {
    console.error('Error fetching doc:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch document' });
  }
});

// 4) Update status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'Missing status value' });
    }

    const docRef = db.collection(COLLECTION).doc(req.params.id);
    await docRef.update({ status });

    return res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    console.error('Error updating status:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// 5) Delete a document
router.delete('/:id', async (req, res) => {
  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    await docRef.delete();

    return res.json({ success: true, message: 'Document deleted' });
  } catch (err) {
    console.error('Error deleting doc:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete document' });
  }
});

module.exports = router;
