import express from "express";
import cron from "node-cron";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs/promises";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Middleware to parse JSON bodies
app.use(express.json());

// Store jobs in a JSON file
const JOBS_FILE = join(__dirname, "../data/jobs.json");

// Ensure data directory exists
async function ensureDataDirectory() {
  const dataDir = join(__dirname, "../data");
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Load jobs from file
async function loadJobs() {
  try {
    const data = await fs.readFile(JOBS_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save jobs to file
async function saveJobs(jobs) {
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// Initialize jobs from file and start them
async function initializeJobs() {
  await ensureDataDirectory();
  const jobs = await loadJobs();

  Object.entries(jobs).forEach(([id, job]) => {
    startJob(id, job.url, job.schedule, job.cronSecret);
  });
}

// Store active cron jobs
const activeJobs = new Map();

// Function to start a cron job
function startJob(id, url, schedule, cronSecret) {
  // Stop existing job if any
  if (activeJobs.has(id)) {
    activeJobs.get(id).stop();
  }

  // Create and start new job
  const job = cron.schedule(schedule, async () => {
    try {
      const headers = {
        "Content-Type": "application/json",
      };

      // Add authorization header if cronSecret is provided
      if (cronSecret) {
        headers["Authorization"] = `Bearer ${cronSecret}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
      });

      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Job ${id} executed: ${response.status}`);
    } catch (error) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] Error executing job ${id}:`, error.message);
    }
  });

  activeJobs.set(id, job);
}

// Middleware to check API key
const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized - Invalid API Key" });
  }
  next();
};

// Routes

// Add a new cron job
app.post("/jobs", apiKeyMiddleware, async (req, res) => {
  try {
    const { id, url, schedule, cronSecret } = req.body;

    if (!id || !url || !schedule) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validate cron schedule
    if (!cron.validate(schedule)) {
      return res.status(400).json({ error: "Invalid cron schedule" });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    const jobs = await loadJobs();
    jobs[id] = {
      url,
      schedule,
      cronSecret,
      createdAt: new Date().toISOString(),
      createdBy: "JIMEX-X",
    };
    await saveJobs(jobs);

    startJob(id, url, schedule, cronSecret);

    res.json({
      message: "Job added successfully",
      job: {
        id,
        url,
        schedule,
        createdAt: jobs[id].createdAt,
        createdBy: jobs[id].createdBy,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all jobs
app.get("/jobs", apiKeyMiddleware, async (req, res) => {
  try {
    const jobs = await loadJobs();
    // Remove sensitive data (cronSecret) from response
    const sanitizedJobs = Object.entries(jobs).reduce((acc, [id, job]) => {
      const { cronSecret, ...safeJob } = job;
      acc[id] = safeJob;
      return acc;
    }, {});
    res.json(sanitizedJobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a job
app.delete("/jobs/:id", apiKeyMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const jobs = await loadJobs();

    if (!jobs[id]) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Stop the job if it's running
    if (activeJobs.has(id)) {
      activeJobs.get(id).stop();
      activeJobs.delete(id);
    }

    delete jobs[id];
    await saveJobs(jobs);

    res.json({ message: "Job deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeJobs: activeJobs.size,
  });
});

// Self-ping to prevent sleep
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
function setupSelfPing() {
  const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${serverUrl}/health`);
      console.log(`[${new Date().toISOString()}] Self-ping successful`);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Self-ping failed:`,
        error.message
      );
    }
  }, PING_INTERVAL);
}

// Start the server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeJobs();
  setupSelfPing();
});
