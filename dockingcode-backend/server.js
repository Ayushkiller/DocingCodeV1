const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const WebSocket = require('ws');
const winston = require('winston');
<<<<<<< Updated upstream
const fetch = require('node-fetch');

=======
const os = require('os');
>>>>>>> Stashed changes
// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Add console logging in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Initialize Express app and other constants
const app = express();
const execAsync = util.promisify(exec);
const TEMP_DIR = path.join(require('os').tmpdir(), 'dockingcode');
const ALLOWED_EXTENSIONS = ['.js', '.jsx', '.py', '.java', '.ts', '.html', '.css'];

// Initialize DocumentationService
const DocumentationService = require('./DocumentationService');
const docService = new DocumentationService({ 
  logger,
  tempDir: TEMP_DIR
});

// Basic setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const wss = new WebSocket.Server({ port: 5001 });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// AI analysis function
async function analyzeCodeWithAI(functionName, parameters, code) {
  try {
    const prompt = `Analyze this function and provide a clear, concise description of what it does:

Function name: ${functionName}
Parameters: ${parameters.join(', ')}
Code:
${code}

Provide a technical description in the following format:
1. Purpose: [1-2 sentences describing what the function does]
2. Parameters: [explain each parameter's purpose]
3. Returns: [what the function returns]
4. Key operations: [list main operations/steps]`;

    const response = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen2.5-coder-7b-instruct',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    logger.error('AI analysis failed', {
      functionName,
      error: error.message
    });
    return null;
  }
}

// Helper functions
const sendProgress = (ws, stage, progress, details = null) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ 
      stage, 
      progress,
      ...(details && { details })
    }));
    logger.debug('Progress update sent', { stage, progress });
  }
};

const cleanup = async (path) => {
  try {
    if (!path) return;
    const cmd = process.platform === 'win32' ? 
      `rmdir /s /q "${path}"` : 
      `rm -rf "${path}"`;
    await execAsync(cmd);
    logger.info('Cleanup completed', { path });
  } catch (error) {
    logger.error('Cleanup failed', { path, error: error.message });
  }
};

const cloneRepo = async (owner, repo) => {
  const repoPath = path.join(TEMP_DIR, `${owner}-${repo}-${Date.now()}`);
  try {
    logger.info('Cloning repository', { owner, repo, repoPath });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    
    // Try HTTPS first
    try {
      await execAsync(
        `git clone https://github.com/${owner}/${repo}.git ${repoPath}`
      );
    } catch (httpsError) {
      // If HTTPS fails, try SSH
      logger.warn('HTTPS clone failed, trying SSH', { 
        owner, 
        repo, 
        error: httpsError.message 
      });
      await execAsync(
        `git clone git@github.com:${owner}/${repo}.git ${repoPath}`
      );
    }
    
    logger.info('Repository cloned successfully', { owner, repo });
    return repoPath;
  } catch (error) {
    logger.error('Repository clone failed', { 
      owner, 
      repo, 
      error: error.message,
      command: error.cmd
    });
    throw new Error(`Failed to clone repository: ${error.message}`);
  }
};

<<<<<<< Updated upstream
// Documentation generator
const generateDocumentation = async (filePath) => {
  const extension = path.extname(filePath);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    logger.debug('Skipping unsupported file', { filePath, extension });
    return null;
  }

  try {
    logger.debug('Processing file', { filePath });
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const docs = [];
    let currentDoc = '';
    let inComment = false;
    let functionCode = '';
    let collectingFunction = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Handle comment blocks
      if (line.match(/^\/\*\*|^"""|^'''|^\/\*/)) {
        inComment = true;
        continue;
      }
      if (line.match(/\*\/|"""|'''$/)) {
        inComment = false;
        continue;
      }
      
      // Collect documentation
      if (inComment || line.startsWith('//') || line.startsWith('#')) {
        currentDoc += line.replace(/^\/\/|^\#|\*\s?/g, '').trim() + '\n';
        continue;
      }

      // Function detection
      const functionMatch = line.match(/(?:function|def|\b(?:public|private|protected)?\s+\w+)\s+(\w+)\s*\((.*?)\)/);
      if (functionMatch) {
        if (collectingFunction) {
          // Save previous function
          functionCode = functionCode.trim();
          if (functionCode) {
            const lastDoc = docs[docs.length - 1];
            if (lastDoc && !lastDoc.description.trim()) {
              const aiAnalysis = await analyzeCodeWithAI(
                lastDoc.name,
                lastDoc.parameters,
                functionCode
              );
              if (aiAnalysis) {
                lastDoc.description = aiAnalysis;
                lastDoc.isAIGenerated = true;
              }
            }
          }
        }

        collectingFunction = true;
        functionCode = '';
        docs.push({
          name: functionMatch[1],
          parameters: functionMatch[2].split(',').map(p => p.trim()).filter(Boolean),
          description: currentDoc.trim()
        });
        currentDoc = '';
      }

      if (collectingFunction) {
        functionCode += line + '\n';
      }
    }

    // Handle last function
    if (collectingFunction && functionCode.trim()) {
      const lastDoc = docs[docs.length - 1];
      if (lastDoc && !lastDoc.description.trim()) {
        const aiAnalysis = await analyzeCodeWithAI(
          lastDoc.name,
          lastDoc.parameters,
          functionCode.trim()
        );
        if (aiAnalysis) {
          lastDoc.description = aiAnalysis;
          lastDoc.isAIGenerated = true;
        }
      }
    }

    if (docs.length) {
      logger.debug('Documentation generated', { 
        filePath, 
        functionCount: docs.length 
      });
    }
    return docs.length ? docs : null;
  } catch (error) {
    logger.error('Documentation generation failed', { 
      filePath, 
      error: error.message 
    });
    throw error;
  }
};

// Wiki content generator
const generateWikiContent = (documentation) => {
  logger.debug('Generating wiki content', { 
    fileCount: documentation.length 
  });
  
  return documentation.reduce((content, doc) => {
    content += `## ${doc.fileName}\n\n`;
    
    if (Array.isArray(doc.content)) {
      doc.content.forEach(func => {
        content += `### ${func.name}\n\n`;
        if (func.isAIGenerated) {
          content += `> *This documentation was automatically generated using AI analysis*\n\n`;
        }
        content += `${func.description}\n\n`;
        if (func.parameters?.length) {
          content += `**Parameters:**\n\n${func.parameters.map(p => `- \`${p}\``).join('\n')}\n\n`;
        }
      });
    }
    
    return content;
  }, '# API Documentation\n\n');
};

// Wiki publishing functions
=======

>>>>>>> Stashed changes
const publishToWiki = async (owner, repo, wikiContent) => {
  const wikiPath = path.join(TEMP_DIR, `${owner}-${repo}-wiki-${Date.now()}`);
  
  try {
    logger.info('Cloning wiki repository', { owner, repo });
    await execAsync(`git clone https://github.com/${owner}/${repo}.wiki.git ${wikiPath}`);
    
    await fs.writeFile(path.join(wikiPath, 'Home.md'), wikiContent);
    
    await execAsync('git config --global user.email "auto-doc@example.com"', { cwd: wikiPath });
    await execAsync('git config --global user.name "Auto Documentation"', { cwd: wikiPath });
    
    await execAsync('git add Home.md', { cwd: wikiPath });
    await execAsync('git commit -m "Update documentation"', { cwd: wikiPath });
    
    const gitPushCmd = `git push https://${process.env.GITHUB_TOKEN}@github.com/${owner}/${repo}.wiki.git master`;
    await execAsync(gitPushCmd, { cwd: wikiPath });
    
    logger.info('Wiki updated successfully', { owner, repo });
    return `https://github.com/${owner}/${repo}/wiki`;
  } catch (error) {
    logger.error('Wiki update failed', {
      owner,
      repo,
      error: error.message,
      command: error.cmd
    });
    throw error;
  } finally {
    try {
      await cleanup(wikiPath);
    } catch (cleanupError) {
      logger.error('Wiki cleanup failed', { 
        path: wikiPath, 
        error: cleanupError.message 
      });
    }
  }
};

<<<<<<< Updated upstream
// Main API endpoint
app.post('/api/generate-docs', async (req, res) => {
  const { owner, repo } = req.body;
  let repoPath = null;
=======

// Main documentation endpoint
app.post('/api/generate-docs', async (req, res) => {
  const { owner, repo } = req.body;
  let repoPath = null;
  let wikiPath = null;
  const ws = Array.from(wss.clients)[0];
>>>>>>> Stashed changes

  logger.info('Documentation generation started', { owner, repo });

  try {
    // Clone repository
    repoPath = await cloneRepo(owner, repo);
    sendProgress(ws, "Repository cloned", 20);

    // Process files
    const documentation = [];
    const files = await fs.readdir(repoPath, { recursive: true });
    const totalFiles = files.length;
    
    let processedFiles = 0;
    for (const file of files) {
      const filePath = path.join(repoPath, file);
      const stats = await fs.stat(filePath);

      if (!stats.isDirectory() && 
          stats.size <= 5 * 1024 * 1024 && 
          !file.includes('node_modules')) {
        
        try {
            // Get file content
            const content = await fs.readFile(filePath, 'utf-8');
            // Generate AI analysis
            const aiAnalysis = await docService.generateCompletion(content);
            
            documentation.push({ 
              fileName: file, 
              content: aiAnalysis
            });
          processedFiles++;
          sendProgress(ws, "Generating documentation", 
            20 + (processedFiles / totalFiles * 40));
        } catch (error) {
          logger.warn(`Failed to process file ${file}`, { 
            error: error.message 
          });
          continue;
        }
      }
    }

    // Generate wiki content
    sendProgress(ws, "Generating wiki structure", 70);
    const wikiStructure = await docService.generateDocs(files);

    // Write to wiki
    wikiPath = path.join(TEMP_DIR, `${owner}-${repo}-wiki-${Date.now()}`);
    await docService.writeWikiContent(wikiPath, wikiStructure);
    sendProgress(ws, "Writing wiki content", 90);

    // Publish to GitHub wiki
    const wikiUrl = await publishToWiki(owner, repo, wikiPath);
    sendProgress(ws, "Completed", 100);

    res.json({ 
      documentation,
      wikiUrl,
      structure: wikiStructure
    });

  } catch (error) {
    logger.error('Documentation generation failed', {
      owner,
      repo,
      error: error.message,
      stack: error.stack
    });
    
    // Send error to WebSocket client
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        stage: "error", 
        error: error.message 
      }));
    }
    
    res.status(500).json({ error: error.message });
  } finally {
<<<<<<< Updated upstream
    if (repoPath) {
      await cleanup(repoPath);
    }
=======
    // Cleanup
    await cleanup(repoPath);
    await cleanup(wikiPath);
>>>>>>> Stashed changes
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path
  });
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  logger.info('WebSocket client connected');
  ws.on('close', () => logger.info('WebSocket client disconnected'));
  ws.on('error', (error) => {
    logger.error('WebSocket error', { error: error.message });
  });
});

<<<<<<< Updated upstream
// Start the server
=======
// Start server
>>>>>>> Stashed changes
const port = process.env.PORT || 5000;
app.listen(port, () => {
  logger.info(`Server started`, { port, environment: process.env.NODE_ENV });
});

<<<<<<< Updated upstream
// Global error handlers
=======
// Process error handling
>>>>>>> Stashed changes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', {
    error: error.message,
    stack: error.stack
  });
<<<<<<< Updated upstream
});
=======
});

module.exports = app;
>>>>>>> Stashed changes
