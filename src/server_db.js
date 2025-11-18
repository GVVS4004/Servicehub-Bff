import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import axios from "axios";

import connectDB from "./config/db.js";
import User from "./models/User.js";
import Notification from "./models/Notification.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// =====================
// CONNECT TO MONGODB
// =====================

connectDB();

// =====================
// MIDDLEWARE
// =====================

console.log(process.env.CORS_ORIGIN);

app.use(
  cors({
    origin: "http://localhost:5174",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// =====================
// IN-MEMORY SSE STORAGE
// (SSE connections must remain in-memory)
// =====================

const clients = new Map(); // email -> SSE response object

// =====================
// AUTH ENDPOINTS
// =====================

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find user in MongoDB
    const user = await User.findOne({ email, password });

    console.log("Login attempt:", email);
    console.log("User found:", user);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Set cookie
    res.cookie("userEmail", email, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    });

    console.log(`✅ User logged in: ${email}`);

    res.json({
      success: true,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  const email = req.cookies.userEmail;

  res.clearCookie("userEmail");

  console.log(`👋 User logged out: ${email || "unknown"}`);

  res.json({ success: true });
});

// Get current user
app.get("/api/auth/me", async (req, res) => {
  try {
    const email = req.cookies.userEmail;

    if (!email) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    res.json({
      userId: user.userId,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================
// SSE ENDPOINT
// =====================

app.get("/api/events", async (req, res) => {
  try {
    const email = req.cookies.userEmail;

    if (!email) {
      return res.status(401).send("Not authenticated");
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(
      `data: ${JSON.stringify({
        type: "connected",
        message: "SSE connected",
      })}\n\n`
    );

    // Store the connection
    clients.set(email, res);

    console.log(`✅ SSE connected: ${email} (Total: ${clients.size})`);

    // Send any pending unread notifications for this user from MongoDB
    const pendingNotifications = await Notification.find({
      userEmail: email,
      opened: false
    }).sort({ createdAt: -1 });

    if (pendingNotifications.length > 0) {
      console.log(
        `📬 Sending ${pendingNotifications.length} pending notifications to ${email}`
      );
      pendingNotifications.forEach((notification) => {
        const notificationData = {
          id: notification.notificationId,
          notificationId: notification.sourceNotificationId,
          source: notification.source,
          title: notification.title,
          content: notification.content,
          priority: notification.priority,
          type: notification.type,
          severity: notification.severity,
          timestamp: notification.timestamp,
          read: notification.read,
          opened: notification.opened,
          metadata: notification.metadata,
          trackingEnabled: notification.trackingEnabled,
          trackingCallbackUrl: notification.trackingCallbackUrl,
        };

        res.write(
          `data: ${JSON.stringify({
            type: "notification",
            data: notificationData,
          })}\n\n`
        );
      });
    }

    // Handle client disconnect
    req.on("close", () => {
      clients.delete(email);
      console.log(`❌ SSE disconnected: ${email} (Total: ${clients.size})`);
    });
  } catch (error) {
    console.error("SSE error:", error);
    res.status(500).send("SSE error");
  }
});

// =====================
// NOTIFICATION ENDPOINTS
// =====================

// Receive bulk notifications from PM_INTERFACE
app.post("/api/notifications/receive", async (req, res) => {
  try {
    const {
      source,
      notificationId,
      title,
      content,
      priority,
      type,
      targetUsers,
      metadata,
      trackingEnabled,
      trackingCallbackUrl,
    } = req.body;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📥 Received bulk notification from: ${source || "Unknown"}`);
    console.log(`   Notification ID: ${notificationId}`);
    console.log(`   Title: ${title}`);
    console.log(`   Target Users: ${targetUsers?.length || 0}`);
    console.log(`   Tracking Enabled: ${trackingEnabled}`);
    console.log(`${"=".repeat(60)}\n`);

    // Validate
    if (
      !targetUsers ||
      !Array.isArray(targetUsers) ||
      targetUsers.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: "targetUsers array is required and cannot be empty",
      });
    }

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        error: "title and content are required",
      });
    }

    const results = {
      success: [],
      failed: [],
      total: targetUsers.length,
    };

    // Process each target user
    for (const targetUser of targetUsers) {
      const { email, userId, name } = targetUser;

      if (!email) {
        results.failed.push({
          userId: userId || "unknown",
          name: name || "unknown",
          reason: "Missing email",
        });
        continue;
      }

      // Create user-specific notification object
      const userNotification = {
        notificationId: `${notificationId}-${userId || email}`,
        sourceNotificationId: notificationId,
        userEmail: email,
        userId,
        source: source || "PM_INTERFACE",
        title,
        content,
        priority: priority || "medium",
        type: type || "release_notes",
        severity:
          priority === "high"
            ? "error"
            : priority === "medium"
            ? "warning"
            : "info",
        timestamp: new Date(),
        read: false,
        opened: false,
        metadata: {
          ...metadata,
          targetUser: { userId, name, email },
        },
        trackingEnabled: trackingEnabled || false,
        trackingCallbackUrl,
      };

      try {
        // Store notification in MongoDB
        await Notification.create(userNotification);

        // Check if user is connected via SSE
        const clientRes = clients.get(email);

        if (!clientRes) {
          results.failed.push({
            email,
            userId,
            name,
            reason: "User not connected (notification stored for later)",
          });
          console.log(`📦 Notification stored for ${email} (user not connected)`);
          continue;
        }

        // Send via SSE
        const sseData = {
          id: userNotification.notificationId,
          notificationId: userNotification.sourceNotificationId,
          source: userNotification.source,
          title: userNotification.title,
          content: userNotification.content,
          priority: userNotification.priority,
          type: userNotification.type,
          severity: userNotification.severity,
          timestamp: userNotification.timestamp,
          read: userNotification.read,
          opened: userNotification.opened,
          metadata: userNotification.metadata,
          trackingEnabled: userNotification.trackingEnabled,
          trackingCallbackUrl: userNotification.trackingCallbackUrl,
        };

        clientRes.write(
          `data: ${JSON.stringify({
            type: "notification",
            data: sseData,
          })}\n\n`
        );

        results.success.push({
          email,
          userId,
          name,
          notificationId: userNotification.notificationId,
        });

        console.log(`✅ Notification sent to ${email} (${name})`);
      } catch (error) {
        results.failed.push({
          email,
          userId,
          name,
          reason: "Failed to store/send notification",
          error: error.message,
        });
        console.error(`❌ Failed to process for ${email}:`, error.message);
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📊 Bulk Send Results:`);
    console.log(`   Total: ${results.total}`);
    console.log(`   Success: ${results.success.length}`);
    console.log(`   Failed: ${results.failed.length}`);
    console.log(`${"=".repeat(60)}\n`);

    res.json({
      success: true,
      message: `Bulk notifications processed: ${results.success.length} delivered, ${results.failed.length} failed/stored`,
      clientsNotified: results.success.length,
      results,
    });
  } catch (error) {
    console.error("❌ Error processing bulk notifications:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Mark notification as opened
app.post("/api/notifications/mark-opened", async (req, res) => {
  try {
    const { notificationId } = req.body;
    const userEmail = req.cookies.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!notificationId) {
      return res.status(400).json({ error: "notificationId is required" });
    }

    // Find notification in MongoDB
    const notification = await Notification.findOne({
      notificationId,
      userEmail
    });

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    if (notification.opened) {
      return res.json({
        success: true,
        message: "Already marked as opened",
      });
    }

    // Mark as opened
    notification.read = true;
    notification.opened = true;
    notification.openedAt = new Date();
    await notification.save();

    console.log(
      `✅ Notification marked as opened: ${notificationId} by ${userEmail}`
    );

    // Send tracking callback if enabled
    if (notification.trackingEnabled && notification.trackingCallbackUrl) {
      try {
        const trackingPayload = {
          notificationId: notification.sourceNotificationId,
          userId: notification.metadata?.targetUser?.userId || userEmail,
          userEmail: userEmail,
          userName: notification.metadata?.targetUser?.name || userEmail,
          applicationId: notification.metadata?.applicationId,
          applicationName: notification.metadata?.applicationName || "ServiceHub",
          openedAt: notification.openedAt,
        };

        console.log(`\n${"=".repeat(60)}`);
        console.log(`📤 Sending tracking callback to PM_INTERFACE:`);
        console.log(`   URL: ${notification.trackingCallbackUrl}`);
        console.log(
          `   User: ${trackingPayload.userName} (${trackingPayload.userEmail})`
        );
        console.log(`   Notification ID: ${trackingPayload.notificationId}`);
        console.log(`${"=".repeat(60)}\n`);

        const response = await axios.post(
          notification.trackingCallbackUrl,
          trackingPayload,
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );

        console.log(
          `✅ Tracking callback sent successfully (${response.status})`
        );
      } catch (error) {
        console.error("❌ Failed to send tracking callback:", error.message);
        // Don't fail the request if tracking fails
      }
    }

    res.json({
      success: true,
      notification: {
        id: notification.notificationId,
        notificationId: notification.sourceNotificationId,
        source: notification.source,
        title: notification.title,
        content: notification.content,
        priority: notification.priority,
        type: notification.type,
        severity: notification.severity,
        timestamp: notification.timestamp,
        read: notification.read,
        opened: notification.opened,
        openedAt: notification.openedAt,
        metadata: notification.metadata,
        trackingEnabled: notification.trackingEnabled,
        trackingCallbackUrl: notification.trackingCallbackUrl,
      },
    });
  } catch (error) {
    console.error("Mark opened error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get user's notifications
app.get("/api/notifications", async (req, res) => {
  try {
    const email = req.cookies.userEmail;

    if (!email) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Fetch notifications from MongoDB
    const notifications = await Notification.find({ userEmail: email })
      .sort({ createdAt: -1 });

    // Transform to match expected format
    const transformedNotifications = notifications.map(n => ({
      id: n.notificationId,
      notificationId: n.sourceNotificationId,
      source: n.source,
      title: n.title,
      content: n.content,
      priority: n.priority,
      type: n.type,
      severity: n.severity,
      timestamp: n.timestamp,
      read: n.read,
      opened: n.opened,
      openedAt: n.openedAt,
      metadata: n.metadata,
      trackingEnabled: n.trackingEnabled,
      trackingCallbackUrl: n.trackingCallbackUrl,
    }));

    res.json({
      notifications: transformedNotifications,
      count: transformedNotifications.length,
      unreadCount: transformedNotifications.filter((n) => !n.read).length,
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================
// DEBUG ENDPOINTS
// =====================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    connectedClients: clients.size,
    timestamp: new Date().toISOString(),
  });
});

// Get connected users (debug)
app.get("/api/debug/connected-users", (req, res) => {
  const connectedUsers = Array.from(clients.keys());
  res.json({
    connectedUsers,
    count: connectedUsers.length,
  });
});

// Get stored notifications (debug)
app.get("/api/debug/stored-notifications", async (req, res) => {
  try {
    // Aggregate notifications by user email
    const notificationsByUser = await Notification.aggregate([
      {
        $group: {
          _id: "$userEmail",
          notifications: { $push: "$$ROOT" },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          email: "$_id",
          notifications: 1,
          count: 1,
          _id: 0
        }
      }
    ]);

    res.json({
      users: notificationsByUser,
      totalUsers: notificationsByUser.length,
    });
  } catch (error) {
    console.error("Debug stored notifications error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================
// START SERVER
// =====================

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 ServiceHub Notification Server Started (MongoDB)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📡 Server listening on port ${PORT}`);
  console.log(
    `📥 Bulk notifications: http://localhost:${PORT}/api/notifications/receive`
  );
  console.log(`🌊 SSE endpoint: http://localhost:${PORT}/api/events`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`${"=".repeat(60)}\n`);
});
