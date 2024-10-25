const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const WebSocket = require('ws');
const winston = require('winston');
const axios = require('axios');

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

// Basic setup
app.use(cors());
app.use(express.json());
const wss = new WebSocket.Server({ port: 5001 });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
// Modified AI analysis function to use axios instead of fetch
const analyzeCodeWithAI = async (functionName, parameters, code, totalFiles, analyzedFiles, ws) => {
  const startTime = Date.now();
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

    const response = await axios.post('http://127.0.0.1:1234/v1/chat/completions', {
      model: 'qwen2.5-coder-7b-instruct',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 500
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const endTime = Date.now();
    const timeTaken = endTime - startTime;
    analyzedFiles++;
    const progress = (analyzedFiles / totalFiles) * 100;
    const eta = ((totalFiles - analyzedFiles) * timeTaken) / 1000; // ETA in seconds

    sendProgress(ws, 'analyzing', progress, eta);

    return response.data.choices[0].message.content;
  } catch (error) {
    logger.error('AI analysis failed', {
      functionName,
      error: error.message
    });
    return null;
  }
};

const sendProgress = (ws, stage, progress, eta) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ stage, progress, eta }));
    logger.debug('Progress update sent', { stage, progress, eta });
  }
};

const cleanup = async (path) => {
  try {
    const cmd = process.platform === 'win32' ? `rmdir /s /q "${path}"` : `rm -rf "${path}"`;
    await execAsync(cmd);
    logger.info('Cleanup completed', { path });
  } catch (error) {
    logger.error('Cleanup failed', { path, error: error.message });
    throw error;
  }
};

const cloneRepo = async (owner, repo) => {
  const repoPath = path.join(TEMP_DIR, `${owner}-${repo}-${Date.now()}`);
  try {
    logger.info('Cloning repository', { owner, repo, repoPath });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await execAsync(`git clone git@github.com:${owner}/${repo}.git ${repoPath}`);
    logger.info('Repository cloned successfully', { owner, repo });
    return repoPath;
  } catch (error) {
    logger.error('Repository clone failed', { 
      owner, 
      repo, 
      error: error.message,
      command: error.cmd
    });
    throw error;
  }
};

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
    
    // Determine the default branch
    const { stdout: branchOutput } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: wikiPath });
    const defaultBranch = branchOutput.split('/').pop().trim();
    
    const gitPushCmd = `git push origin ${defaultBranch}`;
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
// Main API endpoint
app.post('/api/generate-docs', async (req, res) => {
  const { owner, repo } = req.body;
  let repoPath = null;

  logger.info('Documentation generation started', { owner, repo });

  try {
    const ws = Array.from(wss.clients)[0];
    repoPath = await cloneRepo(owner, repo);
    sendProgress(ws, "Repository cloned", 30);

    const documentation = [];
    const files = await fs.readdir(repoPath, { recursive: true });
    logger.info('Files found in repository', { fileCount: files.length });
    
    for (const [index, file] of files.entries()) {
      const filePath = path.join(repoPath, file);
      const stats = await fs.stat(filePath);

      if (!stats.isDirectory() && stats.size <= 5 * 1024 * 1024 && !file.includes('node_modules')) {
        const docs = await generateDocumentation(filePath);
        if (docs) {
          documentation.push({ fileName: file, content: docs });
        }
      }

      sendProgress(ws, "Generating documentation", 30 + (index / files.length * 40));
    }

    logger.info('Documentation generation completed', {
      filesProcessed: files.length,
      documentsGenerated: documentation.length
    });

    try {
      const wikiContent = generateWikiContent(documentation);
      const wikiUrl = await publishToWiki(owner, repo, wikiContent);
      
      sendProgress(ws, "Completed", 100);
      res.json({ 
        documentation,
        wikiUrl
      });
    } catch (wikiError) {
      logger.error('Wiki publishing failed', {
        owner,
        repo,
        error: wikiError.message
      });
      sendProgress(ws, "Completed with wiki error", 100);
      res.json({ 
        documentation,
        wikiError: wikiError.message
      });
    }
  } catch (error) {
    logger.error('Documentation generation failed', {
      owner,
      repo,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: error.message });
  } finally {
    if (repoPath) {
      await cleanup(repoPath);
    }
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
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => {
  logger.info(`Server started`, { port, environment: process.env.NODE_ENV });
});

// Global error handlers
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
});