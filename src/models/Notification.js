import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  notificationId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  sourceNotificationId: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    index: true
  },
  userEmail: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: Number,
    index: true
  },
  source: {
    type: String,
    default: 'PM_INTERFACE'
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  priority: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  type: {
    type: String,
    default: 'release_notes'
  },
  severity: {
    type: String,
    enum: ['error', 'warning', 'info'],
    default: 'info'
  },
  read: {
    type: Boolean,
    default: false
  },
  opened: {
    type: Boolean,
    default: false
  },
  openedAt: {
    type: Date,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  trackingEnabled: {
    type: Boolean,
    default: false
  },
  trackingCallbackUrl: {
    type: String,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create indexes for better query performance
notificationSchema.index({ userEmail: 1, createdAt: -1 });
notificationSchema.index({ opened: 1, userEmail: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
