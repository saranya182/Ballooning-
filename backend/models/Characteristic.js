import mongoose from 'mongoose';

const characteristicSchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      required: true,
      index: true
    },

    drawingId: {
      type: String,
      default: ''
    },

    balloonId: {
      type: String,
      default: ''
    },

    number: {
      type: Number,
      required: true
    },

    type: {
      type: String,
      default: 'Dimension'
    },

    value: {
      type: String,
      default: ''
    },

    unit: {
      type: String,
      default: 'mm'
    },

    plusTolerance: {
      type: String,
      default: '0'
    },

    minusTolerance: {
      type: String,
      default: '0'
    },

    upperLimit: {
      type: String,
      default: '0'
    },

    lowerLimit: {
      type: String,
      default: '0'
    },

    specification: {
      type: String,
      default: ''
    },

    inspectionMethod: {
      type: String,
      default: 'Vernier Caliper'
    },

    instrument: {
      type: String,
      default: 'Vernier Caliper'
    },

    actualValue: {
      type: String,
      default: ''
    },

    result: {
      type: String,
      default: 'NOT INSPECTED'
    },

    remarks: {
      type: String,
      default: ''
    },

    page: {
      type: Number,
      default: 1
    },

    x: {
      type: Number,
      default: 0
    },

    y: {
      type: Number,
      default: 0
    },

    /*
      Page-relative position (0..1) - stays locked to the
      detected dimension regardless of the zoom level.
    */
    xRel: {
      type: Number,
      default: null
    },

    yRel: {
      type: Number,
      default: null
    },

    status: {
      type: String,
      default: 'Needs Verification'
    },

    verified: {
      type: Boolean,
      default: false
    },

    count: {
      type: Number,
      default: 1
    },

    isReference: {
      type: Boolean,
      default: false
    },

    characteristicDesignator: {
      type: String,
      default: 'None'
    },

    notes: {
      type: String,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

const Characteristic =
  mongoose.models.Characteristic ||
  mongoose.model('Characteristic', characteristicSchema);

export default Characteristic;