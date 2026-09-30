import mongoose from 'mongoose';

const balloonSchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      required: true,
      index: true
    },

    drawingId: {
      type: String,
      required: true,
      index: true
    },

    page: {
      type: Number,
      default: 1
    },

    number: {
      type: Number,
      required: true
    },

    x: {
      type: Number,
      required: true
    },

    y: {
      type: Number,
      required: true
    },

    anchorX: {
      type: Number,
      default: 0
    },

    anchorY: {
      type: Number,
      default: 0
    },

    /*
      Page-relative position (0..1) of the balloon and its
      arrow anchor. Unlike x/y (canvas pixels) these values
      do not change when the drawing is zoomed.
    */
    xRel: {
      type: Number,
      default: null
    },

    yRel: {
      type: Number,
      default: null
    },

    anchorXRel: {
      type: Number,
      default: null
    },

    anchorYRel: {
      type: Number,
      default: null
    },

    text: {
      type: String,
      default: ''
    },

    type: {
      type: String,
      default: 'Dimension'
    },

    status: {
      type: String,
      default: 'Draft'
    },

    createdBy: {
      type: String,
      default: ''
    },

    createdAt: {
      type: Date,
      default: Date.now
    },

    updatedAt: {
      type: Date,
      default: Date.now
    }
  }
);

const Balloon =
  mongoose.models.Balloon ||
  mongoose.model('Balloon', balloonSchema);

export default Balloon;
