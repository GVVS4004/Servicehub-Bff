import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "hackathon-secret-key-2024";

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// In-memory storage
const users = [];
const sseConnections = new Map(); // email -> response object
const notifications = new Map(); // notificationId -> notification data
const userNotifications = new Map(); // email -> array of notification IDs

// =====================
// AUTH ROUTES
// =====================

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Check if user exists
    const existingUser = users.find((u) => u.email === email);
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = {
      id: Date.now().toString(),
      email,
      password: hashedPassword,
      createdAt: new Date(),
    };

    users.push(user);

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find user
    const user = users.find((u) => u.email === email);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get current user
app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// =====================
// SSE ROUTE
// =====================

app.get("/api/sse", authenticateToken, (req, res) => {
  const userEmail = req.user.email;

  console.log(`SSE connection established for: ${userEmail}`);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable buffering for nginx

  // Store connection
  sseConnections.set(userEmail, res);

  // Send initial connection message
  res.write(
    `data: ${JSON.stringify({
      type: "connected",
      message: "Connected to notification stream",
    })}\n\n`
  );

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    res.write(
      `data: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`
    );
  }, 30000);

  // Clean up on disconnect
  req.on("close", () => {
    console.log(`SSE connection closed for: ${userEmail}`);
    clearInterval(keepAliveInterval);
    sseConnections.delete(userEmail);
  });
});

// =====================
// NOTIFICATION ROUTES
// =====================

// Send notification to specific user
app.post("/api/notifications/send", authenticateToken, (req, res) => {
  try {
    const { targetEmail, message, type = "info" } = req.body;

    if (!targetEmail || !message) {
      return res
        .status(400)
        .json({ error: "Target email and message required" });
    }

    // Check if user is connected
    const connection = sseConnections.get(targetEmail);

    if (!connection) {
      return res.status(404).json({ error: "User not connected or not found" });
    }

    // Create notification
    const notification = {
      id: Date.now().toString(),
      type,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // Send notification via SSE
    connection.write(
      `data: ${JSON.stringify({
        type: "notification",
        data: notification,
      })}\n\n`
    );

    console.log(`Notification sent to ${targetEmail}:`, notification);

    res.json({
      success: true,
      message: "Notification sent",
      notification,
    });
  } catch (error) {
    console.error("Send notification error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Send bulk notifications (with targetUsers array)
app.post("/api/notifications/send-bulk", authenticateToken, (req, res) => {
  try {
    const notificationData = req.body;

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
    } = notificationData;

    // Validate required fields
    if (!targetUsers || !Array.isArray(targetUsers) || targetUsers.length === 0) {
      return res
        .status(400)
        .json({ error: "targetUsers array is required and cannot be empty" });
    }

    if (!title || !content) {
      return res
        .status(400)
        .json({ error: "title and content are required" });
    }

    // Store the notification data
    const storedNotificationId = notificationId || Date.now().toString();
    notifications.set(storedNotificationId, {
      ...notificationData,
      notificationId: storedNotificationId,
      createdAt: new Date().toISOString(),
    });

    const results = {
      success: [],
      failed: [],
      total: targetUsers.length,
      notificationId: storedNotificationId,
    };

    // Send notification to each target user
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

      // Check if user is connected
      const connection = sseConnections.get(email);

      if (!connection) {
        results.failed.push({
          email,
          userId,
          name,
          reason: "User not connected",
        });
        return;
      }

      // Create user-specific notification
      const userNotification = {
        id: `${storedNotificationId}-${userId || email}`,
        notificationId: storedNotificationId,
        source,
        title,
        content,
        priority: priority || "medium",
        type: type || "info",
        timestamp: new Date().toISOString(),
        read: false,
        metadata: {
          ...metadata,
          targetUser: { userId, name, email },
        },
        trackingEnabled: trackingEnabled || false,
        trackingCallbackUrl,
      };

      try {
        // Send notification via SSE
        connection.write(
          `data: ${JSON.stringify({
            type: "notification",
            data: userNotification,
          })}\n\n`
        );

        // Store notification for this user
        if (!userNotifications.has(email)) {
          userNotifications.set(email, []);
        }
        userNotifications.get(email).push(userNotification);

        results.success.push({
          email,
          userId,
          name,
          notificationId: userNotification.id,
        });

        console.log(`Notification sent to ${email}:`, {
          id: userNotification.id,
          title,
          priority,
        });
      } catch (error) {
        results.failed.push({
          email,
          userId,
          name,
          reason: "Failed to send notification",
          error: error.message,
        });
      }
    });

    res.json({
      success: true,
      message: "Bulk notifications processed",
      results,
    });
  } catch (error) {
    console.error("Send bulk notifications error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get user's notifications
app.get("/api/notifications/user", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const userNotifs = userNotifications.get(userEmail) || [];

    res.json({
      notifications: userNotifs,
      count: userNotifs.length,
      unreadCount: userNotifs.filter(n => !n.read).length,
    });
  } catch (error) {
    console.error("Get user notifications error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Mark notification as read
app.post("/api/notifications/mark-read/:notificationId", authenticateToken, (req, res) => {
  try {
    const { notificationId } = req.params;
    const userEmail = req.user.email;

    const userNotifs = userNotifications.get(userEmail);
    if (!userNotifs) {
      return res.status(404).json({ error: "No notifications found" });
    }

    const notification = userNotifs.find(n => n.id === notificationId);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    notification.read = true;
    notification.readAt = new Date().toISOString();

    res.json({ success: true, notification });
  } catch (error) {
    console.error("Mark notification as read error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Track notification open (callback endpoint)
app.post("/api/notifications/track-open", (req, res) => {
  try {
    const { notificationId, userId, email, openedAt } = req.body;

    console.log("Notification opened:", {
      notificationId,
      userId,
      email,
      openedAt: openedAt || new Date().toISOString(),
    });

    // Here you would typically store this tracking data
    // For now, we'll just log it

    res.json({ success: true, message: "Tracking recorded" });
  } catch (error) {
    console.error("Track notification open error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get all connected users (for demo/testing)
app.get("/api/notifications/connected-users", authenticateToken, (req, res) => {
  const connectedUsers = Array.from(sseConnections.keys());
  res.json({ connectedUsers, count: connectedUsers.length });
});

// =====================
// MIDDLEWARE
// =====================

function authenticateToken(req, res, next) {
  // Get token from header or query (query for SSE)
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1] || req.query.token;

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

// =====================
// START SERVER
// =====================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/api/sse`);
});
