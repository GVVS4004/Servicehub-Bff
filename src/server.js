import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 6000;

// =====================
// MIDDLEWARE
// =====================

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// =====================
// IN-MEMORY STORAGE
// =====================

// Hardcoded users for POC
const users = [
  {
    userId: 1,
    name: "John Doe",
    email: "john.doe@company.com",
    password: "password123",
  },
  {
    userId: 2,
    name: "Jane Smith",
    email: "jane.smith@company.com",
    password: "password123",
  },
  {
    userId: 3,
    name: "Mike Johnson",
    email: "mike.j@company.com",
    password: "password123",
  },
  {
    userId: 4,
    name: "Sarah Wilson",
    email: "sarah.w@company.com",
    password: "password123",
  },
  {
    userId: 5,
    name: "Tom Brown",
    email: "tom.brown@company.com",
    password: "password123",
  },
  {
    userId: 6,
    name: "Emily Davis",
    email: "emily.d@company.com",
    password: "password123",
  },
];

const clients = new Map(); // email -> SSE response object
const userNotifications = new Map(); // email -> array of notifications

// =====================
// AUTH ENDPOINTS
// =====================

// Login
app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find user
    const user = users.find(
      (u) => u.email === email && u.password === password
    );
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
app.get("/api/auth/me", (req, res) => {
  const email = req.cookies.userEmail;

  if (!email) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = users.find((u) => u.email === email);

  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  res.json({
    userId: user.userId,
    email: user.email,
    name: user.name,
  });
});

// =====================
// SSE ENDPOINT
// =====================

app.get("/api/events", (req, res) => {
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

  // Send any pending notifications for this user
  const pending = userNotifications.get(email) || [];
  const unread = pending.filter((n) => !n.opened);

  if (unread.length > 0) {
    console.log(
      `📬 Sending ${unread.length} pending notifications to ${email}`
    );
    unread.forEach((notification) => {
      res.write(
        `data: ${JSON.stringify({
          type: "notification",
          data: notification,
        })}\n\n`
      );
    });
  }

  // Handle client disconnect
  req.on("close", () => {
    clients.delete(email);
    console.log(`❌ SSE disconnected: ${email} (Total: ${clients.size})`);
  });
});

// =====================
// NOTIFICATION ENDPOINTS
// =====================

// Receive bulk notifications from PM_INTERFACE
app.post("/api/notifications/receive", (req, res) => {
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
    targetUsers.forEach((targetUser) => {
      const { email, userId, name } = targetUser;

      if (!email) {
        results.failed.push({
          userId: userId || "unknown",
          name: name || "unknown",
          reason: "Missing email",
        });
        return;
      }

      // Create user-specific notification
      const userNotification = {
        id: `${notificationId}-${userId || email}`,
        notificationId,
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
        timestamp: new Date().toISOString(),
        read: false,
        opened: false,
        metadata: {
          ...metadata,
          targetUser: { userId, name, email },
        },
        trackingEnabled: trackingEnabled || false,
        trackingCallbackUrl,
      };

      // Store notification
      if (!userNotifications.has(email)) {
        userNotifications.set(email, []);
      }
      userNotifications.get(email).push(userNotification);

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
        return;
      }

      try {
        // Send via SSE
        clientRes.write(
          `data: ${JSON.stringify({
            type: "notification",
            data: userNotification,
          })}\n\n`
        );

        results.success.push({
          email,
          userId,
          name,
          notificationId: userNotification.id,
        });

        console.log(`✅ Notification sent to ${email} (${name})`);
      } catch (error) {
        results.failed.push({
          email,
          userId,
          name,
          reason: "Failed to send notification",
          error: error.message,
        });
        console.error(`❌ Failed to send to ${email}:`, error.message);
      }
    });

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

    const userNotifs = userNotifications.get(userEmail) || [];
    const notification = userNotifs.find((n) => n.id === notificationId);

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
    notification.openedAt = new Date().toISOString();

    console.log(
      `✅ Notification marked as opened: ${notificationId} by ${userEmail}`
    );

    // Send tracking callback if enabled
    if (notification.trackingEnabled && notification.trackingCallbackUrl) {
      try {
        const trackingPayload = {
          notificationId: notification.notificationId,
          userId: notification.metadata?.targetUser?.userId || userEmail,
          userEmail: userEmail,
          userName: notification.metadata?.targetUser?.name || userEmail,
          applicationId: notification.metadata?.applicationId,
          applicationName: notification.metadata?.applicationName || "YourApp",
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
      notification,
    });
  } catch (error) {
    console.error("Mark opened error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get user's notifications
app.get("/api/notifications", (req, res) => {
  try {
    const email = req.cookies.userEmail;

    if (!email) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const notifications = userNotifications.get(email) || [];

    res.json({
      notifications,
      count: notifications.length,
      unreadCount: notifications.filter((n) => !n.read).length,
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
app.get("/api/debug/stored-notifications", (req, res) => {
  const storedNotifications = Array.from(userNotifications.entries()).map(
    ([email, notifs]) => ({
      email,
      notifications: notifs,
      count: notifs.length,
    })
  );
  res.json({
    users: storedNotifications,
    totalUsers: storedNotifications.length,
  });
});

// =====================
// START SERVER
// =====================

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Notification Receiver Server Started`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📡 Server listening on port ${PORT}`);
  console.log(
    `📥 Bulk notifications: http://localhost:${PORT}/api/notifications/receive`
  );
  console.log(`🌊 SSE endpoint: http://localhost:${PORT}/api/events`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`${"=".repeat(60)}\n`);
});
