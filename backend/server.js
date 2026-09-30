import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/manufacturing-inspection';

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'Inspector' }
});
const projectSchema = new mongoose.Schema({
  projectNumber: String,
  customerName: String,
  customerPO: String,
  partNumber: String,
  partName: String,
  drawingNumber: String,
  revision: String,
  drawingDate: String,
  material: String,
  quantity: String,
  customerContact: String,
  inspector: String,
  reviewer: String,
  priority: String,
  dueDate: String,
  invoiceNo: String,
  invoiceDate: String,
  unit: { type: String, default: 'mm' },
  remarks: String,
  status: { type: String, default: 'Draft' },
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const drawingSchema = new mongoose.Schema({
  projectId: String,
  fileName: String,
  filePath: String,
  pageCount: Number,
  uploadedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const balloonSchema = new mongoose.Schema({
  projectId: String,
  drawingId: String,
  page: Number,
  number: Number,
  x: Number,
  y: Number,
  anchorX: Number,
  anchorY: Number,
  /*
    Page-relative position (0..1). Unlike x/y (canvas pixels)
    these never drift when the drawing is zoomed in or out.
  */
  xRel: Number,
  yRel: Number,
  anchorXRel: Number,
  anchorYRel: Number,
  text: String,
  type: String,
  status: String,
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const characteristicSchema = new mongoose.Schema({
  projectId: String,
  balloonId: String,
  number: Number,
  type: String,
  value: String,
  unit: String,
  plusTolerance: String,
  minusTolerance: String,
  upperLimit: String,
  lowerLimit: String,
  specification: String,
  inspectionMethod: String,
  instrument: String,
  actualValue: String,
  result: String,
  remarks: String,
  page: Number,
  x: Number,
  y: Number,
  xRel: Number,
  yRel: Number,
  status: String
});
const inspectionSchema = new mongoose.Schema({
  projectId: String,
  inspector: String,
  reviewer: String,
  status: String,
  comments: String,
  approvedBy: String,
  approvedDate: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const approvalSchema = new mongoose.Schema({
  projectId: String,
  status: String,
  comments: String,
  approvedBy: String,
  approvedDate: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Project = mongoose.model('Project', projectSchema);
const Drawing = mongoose.model('Drawing', drawingSchema);
const Balloon = mongoose.model('Balloon', balloonSchema);
const Characteristic = mongoose.model('Characteristic', characteristicSchema);
const Inspection = mongoose.model('Inspection', inspectionSchema);
const Approval = mongoose.model('Approval', approvalSchema);

const fallbackState = {
  users: [],
  projects: [],
  drawings: [],
  balloons: [],
  characteristics: [],
  inspections: [],
  approvals: []
};

const isDbReady = () => mongoose.connection.readyState === 1;
const toPlain = (item) => (item && typeof item.toObject === 'function' ? item.toObject() : { ...item });
const ensureSeedData = async () => {
  if (isDbReady()) {
    const count = await User.countDocuments();
    if (count === 0) {
      await User.create({ name: 'Admin User', email: 'admin@example.com', password: 'admin123', role: 'Admin' });
      await User.create({ name: 'Inspector One', email: 'inspector@example.com', password: 'admin123', role: 'Inspector' });
      await User.create({ name: 'Reviewer One', email: 'reviewer@example.com', password: 'admin123', role: 'Reviewer' });
    }
    const projectCount = await Project.countDocuments();
    if (projectCount === 0) {
      const project = await Project.create({
        projectNumber: 'PRJ-1001',
        customerName: 'ABC Engineering Pvt Ltd',
        customerPO: 'PO-221',
        partNumber: 'MT-1001',
        partName: 'Mounting Plate',
        drawingNumber: 'DWG-1001',
        revision: 'A',
        drawingDate: '2026-07-01',
        material: 'Aluminum 6061',
        quantity: '50',
        customerContact: 'Ravi Kumar',
        inspector: 'Inspector One',
        reviewer: 'Reviewer One',
        priority: 'High',
        dueDate: '2026-08-20',
        remarks: 'Demo project for ballooning workflow',
        status: 'Draft',
        createdBy: 'Admin User'
      });
      const drawingDoc = await Drawing.create({ projectId: project._id, fileName: 'DWG-1001.pdf', filePath: '/uploads/demo.pdf', pageCount: 1 });
      const balloons = [
        { projectId: project._id, drawingId: drawingDoc._id, number: 1, text: '100 ± 0.10', type: 'Dimension', x: 280, y: 160, anchorX: 300, anchorY: 180, status: 'Draft' },
        { projectId: project._id, drawingId: drawingDoc._id, number: 2, text: '50 ± 0.05', type: 'Dimension', x: 240, y: 230, anchorX: 260, anchorY: 250, status: 'Draft' },
        { projectId: project._id, drawingId: drawingDoc._id, number: 3, text: 'Ø20 +0.05/-0.00', type: 'Diameter', x: 360, y: 280, anchorX: 380, anchorY: 300, status: 'Draft' }
      ];
      for (const balloon of balloons) {
        await Balloon.create(balloon);
      }
      const characteristics = [
        { projectId: project._id, drawingId: drawingDoc._id, balloonId: uuidv4(), number: 1, type: 'Dimension', value: '100', unit: 'mm', plusTolerance: '0.10', minusTolerance: '-0.10', upperLimit: '100.10', lowerLimit: '99.90', specification: '100 ± 0.10', inspectionMethod: 'Vernier Caliper', instrument: 'Vernier', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 280, y: 160, status: 'Draft' },
        { projectId: project._id, drawingId: drawingDoc._id, balloonId: uuidv4(), number: 2, type: 'Dimension', value: '50', unit: 'mm', plusTolerance: '0.05', minusTolerance: '-0.05', upperLimit: '50.05', lowerLimit: '49.95', specification: '50 ± 0.05', inspectionMethod: 'Micrometer', instrument: 'Micrometer', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 240, y: 230, status: 'Draft' },
        { projectId: project._id, drawingId: drawingDoc._id, balloonId: uuidv4(), number: 3, type: 'Diameter', value: '20', unit: 'mm', plusTolerance: '0.05', minusTolerance: '0.00', upperLimit: '20.05', lowerLimit: '20.00', specification: 'Ø20 +0.05/-0.00', inspectionMethod: 'Gauge', instrument: 'Go/No-Go', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 360, y: 280, status: 'Draft' }
      ];
      for (const characteristic of characteristics) {
        await Characteristic.create(characteristic);
      }
    }
    return;
  }

  if (fallbackState.users.length === 0) {
    fallbackState.users.push(
      { _id: uuidv4(), name: 'Admin User', email: 'admin@example.com', password: 'admin123', role: 'Admin' },
      { _id: uuidv4(), name: 'Inspector One', email: 'inspector@example.com', password: 'admin123', role: 'Inspector' },
      { _id: uuidv4(), name: 'Reviewer One', email: 'reviewer@example.com', password: 'admin123', role: 'Reviewer' }
    );
  }

  if (fallbackState.projects.length === 0) {
    const project = {
      _id: uuidv4(),
      projectNumber: 'PRJ-1001',
      customerName: 'ABC Engineering Pvt Ltd',
      customerPO: 'PO-221',
      partNumber: 'MT-1001',
      partName: 'Mounting Plate',
      drawingNumber: 'DWG-1001',
      revision: 'A',
      drawingDate: '2026-07-01',
      material: 'Aluminum 6061',
      quantity: '50',
      customerContact: 'Ravi Kumar',
      inspector: 'Inspector One',
      reviewer: 'Reviewer One',
      priority: 'High',
      dueDate: '2026-08-20',
      remarks: 'Demo project for ballooning workflow',
      status: 'Draft',
      createdBy: 'Admin User',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    fallbackState.projects.push(project);
    const drawing = { _id: uuidv4(), projectId: project._id, fileName: 'DWG-1001.pdf', filePath: '/uploads/demo.pdf', pageCount: 1, uploadedAt: new Date() };
    fallbackState.drawings.push(drawing);
    fallbackState.balloons.push(
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, number: 1, text: '100 ± 0.10', type: 'Dimension', x: 280, y: 160, anchorX: 300, anchorY: 180, status: 'Draft', createdAt: new Date(), updatedAt: new Date() },
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, number: 2, text: '50 ± 0.05', type: 'Dimension', x: 240, y: 230, anchorX: 260, anchorY: 250, status: 'Draft', createdAt: new Date(), updatedAt: new Date() },
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, number: 3, text: 'Ø20 +0.05/-0.00', type: 'Diameter', x: 360, y: 280, anchorX: 380, anchorY: 300, status: 'Draft', createdAt: new Date(), updatedAt: new Date() }
    );
    fallbackState.characteristics.push(
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, balloonId: uuidv4(), number: 1, type: 'Dimension', value: '100', unit: 'mm', plusTolerance: '0.10', minusTolerance: '-0.10', upperLimit: '100.10', lowerLimit: '99.90', specification: '100 ± 0.10', inspectionMethod: 'Vernier Caliper', instrument: 'Vernier', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 280, y: 160, status: 'Draft' },
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, balloonId: uuidv4(), number: 2, type: 'Dimension', value: '50', unit: 'mm', plusTolerance: '0.05', minusTolerance: '-0.05', upperLimit: '50.05', lowerLimit: '49.95', specification: '50 ± 0.05', inspectionMethod: 'Micrometer', instrument: 'Micrometer', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 240, y: 230, status: 'Draft' },
      { _id: uuidv4(), projectId: project._id, drawingId: drawing._id, balloonId: uuidv4(), number: 3, type: 'Diameter', value: '20', unit: 'mm', plusTolerance: '0.05', minusTolerance: '0.00', upperLimit: '20.05', lowerLimit: '20.00', specification: 'Ø20 +0.05/-0.00', inspectionMethod: 'Gauge', instrument: 'Go/No-Go', actualValue: '', result: 'NOT INSPECTED', remarks: '', page: 1, x: 360, y: 280, status: 'Draft' }
    );
    fallbackState.inspections.push({ _id: uuidv4(), projectId: project._id, inspector: 'Inspector One', reviewer: 'Reviewer One', status: 'Draft', comments: '', approvedBy: '', approvedDate: null, createdAt: new Date(), updatedAt: new Date() });
  }
};

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/ocr/detect', async (req, res) => {
  try {
    const { imageBase64, isCrop } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    console.log('OCR request received, image size:', imageBase64.length, 'chars, isCrop:', isCrop);

    // Forward to the persistent Python OCR server
    const response = await fetch('http://127.0.0.1:5050', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, isCrop })
    });

    const result = await response.json();
    console.log('OCR result: ', result.detections?.length || 0, 'detections');
    res.json(result);

  } catch (error) {
    console.error('OCR Error:', error);
    res.status(500).json({ 
      error: 'OCR server not running. Please start it with: python ocr_service.py', 
      details: error.message 
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (isDbReady()) {
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    return res.json({ user: { id: user._id, email: user.email, role: user.role, name: user.name } });
  }
  const user = fallbackState.users.find((entry) => entry.email === email && entry.password === password);
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });
  res.json({ user: { id: user._id, email: user.email, role: user.role, name: user.name } });
});

app.get('/api/projects', async (req, res) => {
  if (isDbReady()) {
    const projects = await Project.find().sort({ createdAt: -1 });
    return res.json(projects.map(toPlain));
  }
  res.json([...fallbackState.projects].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/projects', async (req, res) => {
  const payload = { ...req.body, createdBy: req.body.createdBy || 'Admin', createdAt: new Date(), updatedAt: new Date() };
  if (isDbReady()) {
    const project = await Project.create(payload);
    await Inspection.create({ projectId: project._id, inspector: project.inspector, reviewer: project.reviewer, status: 'Draft' });
    return res.status(201).json(toPlain(project));
  }
  const project = { _id: uuidv4(), ...payload };
  fallbackState.projects.push(project);
  fallbackState.inspections.push({ _id: uuidv4(), projectId: project._id, inspector: project.inspector, reviewer: project.reviewer, status: 'Draft', comments: '', approvedBy: '', approvedDate: null, createdAt: new Date(), updatedAt: new Date() });
  res.status(201).json(project);
});

app.get('/api/projects/:id', async (req, res) => {
  if (isDbReady()) {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    return res.json(toPlain(project));
  }
  const project = fallbackState.projects.find((entry) => entry._id === req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  res.json(project);
});

app.put('/api/projects/:id', async (req, res) => {
  if (isDbReady()) {
    const project = await Project.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    return res.json(toPlain(project));
  }
  const project = fallbackState.projects.find((entry) => entry._id === req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  Object.assign(project, { ...req.body, updatedAt: new Date() });
  res.json(project);
});

app.delete('/api/projects/:id', async (req, res) => {
  if (isDbReady()) {
    await Project.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  }
  fallbackState.projects = fallbackState.projects.filter((entry) => entry._id !== req.params.id);
  fallbackState.balloons = fallbackState.balloons.filter((entry) => entry.projectId !== req.params.id);
  fallbackState.characteristics = fallbackState.characteristics.filter((entry) => entry.projectId !== req.params.id);
  fallbackState.drawings = fallbackState.drawings.filter((entry) => entry.projectId !== req.params.id);
  fallbackState.inspections = fallbackState.inspections.filter((entry) => entry.projectId !== req.params.id);
  fallbackState.approvals = fallbackState.approvals.filter((entry) => entry.projectId !== req.params.id);
  res.json({ success: true });
});

app.post('/api/projects/:id/drawing', upload.single('drawing'), async (req, res) => {
  try {
    const projectId = req.params.id;

    if (!req.file) {
      return res.status(400).json({
        message: 'No file uploaded'
      });
    }

    const drawingData = {
      projectId: projectId,
      fileName: req.file.originalname,
      filePath: `/uploads/${req.file.filename}`,
      pageCount: 1,
      uploadedAt: new Date(),
      updatedAt: new Date()
    };

    // ==============================
    // MONGODB MODE
    // ==============================
    if (isDbReady()) {

      // Create new drawing
      // IMPORTANT:
      // Do NOT add _id here.
      // MongoDB will automatically generate ObjectId.
      const storedDrawing = await Drawing.create(drawingData);

      console.log('New drawing saved:', storedDrawing._id);

      return res.status(201).json(
        toPlain(storedDrawing)
      );
    }

    // ==============================
    // FALLBACK MODE
    // ==============================

    // UUID is okay ONLY in fallback memory mode
    const newDrawing = {
      _id: uuidv4(),
      ...drawingData
    };

    fallbackState.drawings.push(newDrawing);

    console.log('New fallback drawing saved:', newDrawing._id);

    return res.status(201).json(newDrawing);

  } catch (error) {

    console.error('Drawing upload error:', error);

    return res.status(500).json({
      message: 'Failed to upload drawing',
      error: error.message
    });
  }
});

app.get('/api/projects/:id/drawings', async (req, res) => {
  if (isDbReady()) {
    const drawings = await Drawing.find({ projectId: req.params.id }).sort({ uploadedAt: -1 });
    return res.json(drawings.map(toPlain));
  }
  const drawings = fallbackState.drawings.filter((entry) => entry.projectId === req.params.id).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(drawings);
});

app.put('/api/projects/:id/drawings/:drawingId', async (req, res) => {
  const drawingId = req.params.drawingId;
  const payload = { ...req.body, updatedAt: new Date() };
  if (isDbReady()) {
    const drawing = await Drawing.findByIdAndUpdate(drawingId, payload, { new: true });
    if (!drawing) return res.status(404).json({ message: 'Drawing not found' });
    return res.json(toPlain(drawing));
  }
  const drawing = fallbackState.drawings.find((entry) => entry._id === drawingId);
  if (!drawing) return res.status(404).json({ message: 'Drawing not found' });
  Object.assign(drawing, payload);
  res.json(drawing);
});

app.delete('/api/projects/:id/drawings/:drawingId', async (req, res) => {
  const drawingId = req.params.drawingId;
  const unlinkFile = async (drawing) => {
    if (!drawing?.filePath) return;
    const relativePath = drawing.filePath.replace(/^\//, '');
    const filePath = path.join(__dirname, relativePath);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.warn('Unable to delete drawing file', filePath, error.message);
    }
  };

  if (isDbReady()) {
    const drawing = await Drawing.findByIdAndDelete(drawingId);
    if (!drawing) return res.status(404).json({ message: 'Drawing not found' });
    await unlinkFile(drawing);
    return res.json({ success: true });
  }
  const drawing = fallbackState.drawings.find((entry) => entry._id === drawingId);
  if (!drawing) return res.status(404).json({ message: 'Drawing not found' });
  fallbackState.drawings = fallbackState.drawings.filter((entry) => entry._id !== drawingId);
  await unlinkFile(drawing);
  res.json({ success: true });
});

app.get('/api/projects/:id/drawing', async (req, res) => {
  try {

    if (isDbReady()) {

      const drawing = await Drawing
        .findOne({
          projectId: req.params.id
        })
        .sort({
          uploadedAt: -1
        });

      if (!drawing) {
        return res.status(404).json({
          message: 'Drawing not found'
        });
      }

      return res.json(
        toPlain(drawing)
      );
    }

    const drawings = fallbackState.drawings
      .filter(
        entry => entry.projectId === req.params.id
      )
      .sort(
        (a, b) =>
          new Date(b.uploadedAt) -
          new Date(a.uploadedAt)
      );

    if (drawings.length === 0) {
      return res.status(404).json({
        message: 'Drawing not found'
      });
    }

    return res.json(drawings[0]);

  } catch (error) {

    console.error('Get drawing error:', error);

    return res.status(500).json({
      message: 'Failed to get drawing',
      error: error.message
    });
  }
});

app.get('/api/projects/:id/balloons', async (req, res) => {
  const drawingId = req.query.drawingId;
  const filter = { projectId: req.params.id };
  if (drawingId) filter.drawingId = drawingId;
  if (isDbReady()) {
    const balloons = await Balloon.find(filter).sort({ number: 1 });
    return res.json(balloons.map(toPlain));
  }
  let balloons = fallbackState.balloons.filter((entry) => entry.projectId === req.params.id);
  if (drawingId) balloons = balloons.filter((entry) => entry.drawingId === drawingId);
  balloons = balloons.sort((a, b) => a.number - b.number);
  res.json(balloons);
});

app.post('/api/projects/:id/balloons', async (req, res) => {
  const payload = {
    projectId: req.params.id,
    ...req.body,
    number: req.body.number || (fallbackState.balloons.filter((entry) => entry.projectId === req.params.id).length + 1),
    status: req.body.status || 'Draft',
    createdAt: new Date(),
    updatedAt: new Date()
  };
  if (isDbReady()) {
    const balloon = await Balloon.create(payload);
    return res.status(201).json(toPlain(balloon));
  }
  const balloon = { _id: uuidv4(), ...payload };
  fallbackState.balloons.push(balloon);
  res.status(201).json(balloon);
});

app.put('/api/balloons/:id', async (req, res) => {
  if (isDbReady()) {
    const balloon = await Balloon.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    return res.json(toPlain(balloon));
  }
  const balloon = fallbackState.balloons.find((entry) => entry._id === req.params.id);
  if (!balloon) return res.status(404).json({ message: 'Balloon not found' });
  Object.assign(balloon, { ...req.body, updatedAt: new Date() });
  res.json(balloon);
});

app.delete('/api/balloons/:id', async (req, res) => {
  const balloonId = req.params.id;
  if (isDbReady()) {
    const balloon = await Balloon.findByIdAndDelete(balloonId);
    await Characteristic.deleteMany({ balloonId });
    return res.json({ success: true, balloon: toPlain(balloon) });
  }
  fallbackState.balloons = fallbackState.balloons.filter((entry) => entry._id !== balloonId);
  fallbackState.characteristics = fallbackState.characteristics.filter((entry) => entry.balloonId !== balloonId);
  res.json({ success: true });
});

app.get('/api/projects/:id/characteristics', async (req, res) => {
  const drawingId = req.query.drawingId;
  const filter = { projectId: req.params.id };
  if (drawingId) filter.drawingId = drawingId;
  if (isDbReady()) {
    const characteristics = await Characteristic.find(filter);
    return res.json(characteristics.map(toPlain));
  }
  let characteristics = fallbackState.characteristics.filter((entry) => entry.projectId === req.params.id);
  if (drawingId) characteristics = characteristics.filter((entry) => entry.drawingId === drawingId);
  res.json(characteristics);
});

app.post('/api/projects/:id/characteristics', async (req, res) => {
  const payload = { projectId: req.params.id, ...req.body };
  if (isDbReady()) {
    const characteristic = await Characteristic.create(payload);
    return res.status(201).json(toPlain(characteristic));
  }
  const characteristic = { _id: uuidv4(), ...payload };
  fallbackState.characteristics.push(characteristic);
  res.status(201).json(characteristic);
});

app.put('/api/characteristics/:id', async (req, res) => {
  if (isDbReady()) {
    const characteristic = await Characteristic.findByIdAndUpdate(req.params.id, req.body, { new: true });
    return res.json(toPlain(characteristic));
  }
  const characteristic = fallbackState.characteristics.find((entry) => entry._id === req.params.id);
  if (!characteristic) return res.status(404).json({ message: 'Characteristic not found' });
  Object.assign(characteristic, req.body);
  res.json(characteristic);
});

app.delete('/api/characteristics/:id', async (req, res) => {
  if (isDbReady()) {
    await Characteristic.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  }
  fallbackState.characteristics = fallbackState.characteristics.filter((entry) => entry._id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/projects/:id/approval', async (req, res) => {
  if (isDbReady()) {
    const approval = await Approval.create({ projectId: req.params.id, ...req.body, status: req.body.status || 'Submitted for Review' });
    await Project.findByIdAndUpdate(req.params.id, { status: req.body.status || 'Under Review' });
    return res.status(201).json(toPlain(approval));
  }
  const approval = { _id: uuidv4(), projectId: req.params.id, ...req.body, status: req.body.status || 'Submitted for Review' };
  fallbackState.approvals.push(approval);
  const project = fallbackState.projects.find((entry) => entry._id === req.params.id);
  if (project) project.status = req.body.status || 'Under Review';
  res.status(201).json(approval);
});

app.post('/api/projects/:id/export', async (req, res) => {
  res.json({ success: true, message: 'Export placeholder ready' });
});

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await ensureSeedData();
    app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
  })
  .catch((error) => {
    console.error('MongoDB connection error', error.message);
    ensureSeedData().then(() => {
      app.listen(PORT, () => console.log(`Backend running without database on port ${PORT}`));
    });
  });
