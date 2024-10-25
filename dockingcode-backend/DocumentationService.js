const { Groq } = require("groq-sdk");
const path = require("path");
const fs = require("fs").promises;
const axios = require('axios');
require("dotenv").config();

// Simplified key manager that handles API key rotation and rate limiting
class KeyManager {
  constructor(apiKeys = [], logger) {
    this.keys = apiKeys.map(key => ({ key, lastUsed: 0, failCount: 0, isRateLimited: false }));
    this.currentIndex = 0;
    this.logger = logger;
  }

  getNextKey() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const keyInfo = this.keys[this.currentIndex];
      if (keyInfo.isRateLimited && now - keyInfo.lastUsed > 60000) {
        keyInfo.isRateLimited = false;
        keyInfo.failCount = 0;
      }
      if (!keyInfo.isRateLimited) return keyInfo.key;
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }
    throw new Error("All API keys are rate limited");
  }

  markRateLimited(key) {
    const keyInfo = this.keys.find(k => k.key === key);
    if (keyInfo) {
      keyInfo.failCount++;
      keyInfo.lastUsed = Date.now();
      if (keyInfo.failCount >= 3) {
        keyInfo.isRateLimited = true;
        this.logger?.warn("API key rate limited", { key: key.substring(0, 8) });
      }
    }
  }

  resetKey(key) {
    const keyInfo = this.keys.find(k => k.key === key);
    if (keyInfo) {
      keyInfo.failCount = 0;
      keyInfo.isRateLimited = false;
      keyInfo.lastUsed = Date.now();
    }
  }
}

class DocumentationService {
  constructor(config = {}) {
    this.logger = config.logger;
    this.tempDir = config.tempDir || path.join(require("os").tmpdir(), "dockingcode");
    this.model = config.model || "mixtral-8x7b-32768";
    this.keyManager = new KeyManager(this.getApiKeys(config.apiKey), this.logger);
    
    this.modelConfig = {
      "mixtral-8x7b-32768": { temperature: 0.3, max_tokens: 4096 },
      "llama2-70b-4096": { temperature: 0.4, max_tokens: -1}
    };
    
    this.initializeTempDir();
  }

  getApiKeys(configKey) {
    const keys = new Set();
    if (Array.isArray(configKey)) configKey.forEach(key => keys.add(key));
    else if (configKey) keys.add(configKey);
    if (process.env.GROQ_API_KEYS) process.env.GROQ_API_KEYS.split(",").forEach(key => keys.add(key.trim()));
    if (process.env.GROQ_API_KEY) keys.add(process.env.GROQ_API_KEY);
    return [...keys];
  }

  async initializeTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      this.logger?.error("Failed to create temp directory", { dir: this.tempDir, error: error.message });
      throw new Error(`Failed to initialize temp directory: ${error.message}`);
    }
  }

  createLmstudioClient() {
    return axios.create({
      baseURL: 'http://localhost:1234',
      headers: { 'Content-Type': 'application/json' }
    });
  }


  async analyzeDirectory(directoryPath) {
    try {
      const files = await fs.readdir(directoryPath);
      const analyses = [];

      for (const file of files) {
        const filePath = path.join(directoryPath, file);
        const stats = await fs.stat(filePath);

        if (stats.isDirectory()) {
          const subDirAnalyses = await this.analyzeDirectory(filePath);
          analyses.push(...subDirAnalyses);
        } else if (this.shouldAnalyzeFile(file)) {
          const content = await fs.readFile(filePath, 'utf-8');
          analyses.push(content);
        }
      }

      return analyses;
    } catch (error) {
      this.logger?.error("Directory analysis failed", { 
        directoryPath, 
        error: error.message 
      });
      throw new Error(`Failed to analyze directory: ${error.message}`);
    }
  }

  shouldAnalyzeFile(fileName) {
    const validExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.cs'];
    const ext = path.extname(fileName).toLowerCase();
    return validExtensions.includes(ext) && !fileName.startsWith('.');
  }

  async generateCompletion(messages) {
    try {
      const groq = new Groq({ apiKey: this.keyManager.getNextKey() });
      const completion = await groq.chat.completions.create({
        messages: messages,
        model: this.model,
        ...this.modelConfig[this.model]
      });
      return completion.choices[0]?.message?.content || "";
    } catch (error) {
      this.keyManager.markRateLimited(error.config?.apiKey);
      
      // Try LMStudio as fallback
      try {
        const lmstudio = this.createLmstudioClient();
        const response = await lmstudio.post('/v1/chat/completions', {
          model: "qwen2.5-coder-7b-instruct",
          messages: messages,
          temperature: 0.7,
          max_tokens: -1,
          stream: false
        });
        
        return response.data.choices[0]?.message?.content || "";
      } catch (lmError) {
        this.logger?.error("LMStudio completion failed", {
          error: lmError.message,
          details: lmError.response?.data || 'No additional error details'
        });
        throw error; // Throw original error if LMStudio also fails
      }
    }
  }

  async writeWikiContent(wikiPath, content) {
    try {
      for (const [filePath, fileContent] of Object.entries(content)) {
        const fullPath = path.join(wikiPath, filePath);
        
        if (typeof fileContent === "object") {
          await fs.mkdir(fullPath, { recursive: true });
          if (Object.keys(fileContent).length > 0) {
            await this.writeWikiContent(fullPath, fileContent);
          }
        } else {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, fileContent);
        }
      }
    } catch (error) {
      this.logger?.error("Failed to write wiki content", { path: wikiPath, error: error.message });
      throw new Error(`Failed to write wiki content: ${error.message}`);
    }
  }

  async cleanup(directory) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      this.logger?.error("Cleanup failed", { directory, error: error.message });
    }
  }
}

module.exports = DocumentationService;