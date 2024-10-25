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
require('dotenv').config();
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
const chatCompletionsUrl = process.env.CHAT_COMPLETIONS_URL;
// Configuration for AI endpoints
const AI_ENDPOINTS = {
  primary: {
    url: chatCompletionsUrl,
    model: 'qwen2.5-coder-7b-instruct'
  },
  fallback: {
    url: 'http://localhost:1234/v1/chat/completions',
    model: 'qwen2.5-coder-7b-instruct'
  }
};

const analyzeCodeWithAI = async (functionName, parameters, code, totalFiles, analyzedFiles, ws) => {
  const startTime = Date.now();

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

  // Try primary endpoint first
  try {
    const response = await axios.post(AI_ENDPOINTS.primary.url, {
      model: AI_ENDPOINTS.primary.model,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 500
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });

    const endTime = Date.now();
    const timeTaken = endTime - startTime;
    analyzedFiles++;
    const progress = (analyzedFiles / totalFiles) * 100;
    const eta = ((totalFiles - analyzedFiles) * timeTaken) / 1000;

    sendProgress(ws, 'analyzing', progress, eta);

    return response.data.choices[0].message.content;

  } catch (primaryError) {
    logger.warn('Primary AI endpoint failed, attempting fallback', {
      error: primaryError.message,
      functionName
    });

    // Try fallback endpoint
    try {
      const response = await axios.post(AI_ENDPOINTS.fallback.url, {
        model: AI_ENDPOINTS.fallback.model,
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 500
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const endTime = Date.now();
      const timeTaken = endTime - startTime;
      analyzedFiles++;
      const progress = (analyzedFiles / totalFiles) * 100;
      const eta = ((totalFiles - analyzedFiles) * timeTaken) / 1000;

      sendProgress(ws, 'analyzing', progress, eta);

      return response.data.choices[0].message.content;

    } catch (fallbackError) {
      logger.error('Both AI endpoints failed', {
        primaryError: primaryError.message,
        fallbackError: fallbackError.message,
        functionName
      });

      // Return a basic analysis when both endpoints fail
      return `Function ${functionName} - Unable to generate AI analysis. Please review the code manually.`;
    }
  }
};


// Helper function to generate content for a single directory
const generateDirectoryContent = (dirName, dirContent) => {
  let content = `# ${dirName} Directory\n\n`;
  
  if (dirContent.parent) {
    content += `[Back to parent directory](${dirContent.parent})\n\n`;
  }

  // List subdirectories
  if (Object.keys(dirContent.dirs).length > 0) {
    content += '## Subdirectories\n\n';
    Object.keys(dirContent.dirs).forEach(subDir => {
      content += `- [${subDir}](${dirName}/${subDir})\n`;
    });
    content += '\n';
  }

  // Add files content
  if (dirContent.files.length > 0) {
    content += '## Files\n\n';
    dirContent.files.forEach(doc => {
      content += `### ${doc.fileName}\n\n`;
      if (Array.isArray(doc.content)) {
        doc.content.forEach(func => {
          content += `#### ${func.name}\n\n`;
          if (func.isAIGenerated) {
            content += `> *This documentation was automatically generated using AI analysis*\n\n`;
          }
          content += `${func.description}\n\n`;
          if (func.parameters?.length) {
            content += `**Parameters:**\n\n${func.parameters.map(p => `- \`${p}\``).join('\n')}\n\n`;
          }
        });
      }
    });
  }

  return content;
};

// Modified main API endpoint
app.post('/api/generate-docs', async (req, res) => {
  const { owner, repo } = req.body;
  let repoPath = null;
  const directoryStructure = {};

  logger.info('Documentation generation started', { owner, repo });

  try {
    const ws = Array.from(wss.clients)[0];
    repoPath = await cloneRepo(owner, repo);
    sendProgress(ws, "Repository cloned", 30);

    // Get all directories first
    const dirs = new Set();
    const files = await fs.readdir(repoPath, { recursive: true });
    files.forEach(file => {
      const dirPath = path.dirname(file);
      if (dirPath !== '.') {
        dirs.add(dirPath);
      }
    });

    // Process each directory
    const totalDirs = dirs.size + 1; // +1 for root
    let processedDirs = 0;

    // Process root directory first
    const rootFiles = files.filter(file => path.dirname(file) === '.');
    const rootDocs = [];
    for (const file of rootFiles) {
      if (!file.includes('node_modules')) {
        const filePath = path.join(repoPath, file);
        const stats = await fs.stat(filePath);
        
        if (!stats.isDirectory() && stats.size <= 5 * 1024 * 1024) {
          const docs = await generateDocumentation(filePath);
          if (docs) {
            rootDocs.push({ fileName: file, content: docs });
          }
        }
      }
    }

    if (rootDocs.length > 0) {
      await publishToWiki(owner, repo, { 
        files: rootDocs, 
        dirs: directoryStructure 
      }, '');
    }
    
    processedDirs++;
    sendProgress(ws, "Processing directories", 30 + (processedDirs / totalDirs * 70));

    // Process each subdirectory
    for (const dir of dirs) {
      const dirFiles = files.filter(file => path.dirname(file) === dir);
      const dirDocs = [];
      
      for (const file of dirFiles) {
        if (!file.includes('node_modules')) {
          const filePath = path.join(repoPath, file);
          const stats = await fs.stat(filePath);
          
          if (!stats.isDirectory() && stats.size <= 5 * 1024 * 1024) {
            const docs = await generateDocumentation(filePath);
            if (docs) {
              dirDocs.push({ fileName: path.basename(file), content: docs });
            }
          }
        }
      }

      if (dirDocs.length > 0) {
        // Update directory structure and push to wiki
        let currentLevel = directoryStructure;
        const parts = dir.split(path.sep);
        
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (!currentLevel[part]) {
            currentLevel[part] = { files: [], dirs: {} };
          }
          currentLevel = currentLevel[part].dirs;
        }

        const lastPart = parts[parts.length - 1];
        currentLevel[lastPart] = { 
          files: dirDocs, 
          dirs: {},
          parent: parts.length > 1 ? parts.slice(0, -1).join('-') : ''
        };

        await publishToWiki(owner, repo, currentLevel[lastPart], dir);
      }

      processedDirs++;
      sendProgress(ws, "Processing directories", 30 + (processedDirs / totalDirs * 70));
    }

    sendProgress(ws, "Completed", 100);
    res.json({ 
      success: true,
      wikiUrl: `https://github.com/${owner}/${repo}/wiki`
    });

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
// New function to organize files by directory
const organizeFilesByDirectory = (documentation) => {
  const directoryStructure = {};

  documentation.forEach(doc => {
    const parts = doc.fileName.split('/');
    let currentLevel = directoryStructure;
    
    // Handle files in root directory
    if (parts.length === 1) {
      if (!currentLevel.root) {
        currentLevel.root = { files: [], dirs: {} };
      }
      currentLevel.root.files.push(doc);
      return;
    }

    // Process directories
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!currentLevel[part]) {
        currentLevel[part] = { files: [], dirs: {} };
      }
      currentLevel = currentLevel[part].dirs;
    }

    // Add file to its directory
    const fileName = parts[parts.length - 1];
    if (!currentLevel.files) {
      currentLevel.files = [];
    }
    currentLevel.files.push({
      ...doc,
      fileName: fileName
    });
  });

  return directoryStructure;
};

// Function to determine if a directory needs its own page
const shouldCreateSeparatePage = (dirContent) => {
  const totalFiles = dirContent.files.length;
  const hasSubDirs = Object.keys(dirContent.dirs).length > 0;
  return totalFiles > 5 || hasSubDirs;
};

// Function to generate wiki content for a directory
const generateDirectoryWikiContent = (dirName, dirContent, basePath = '') => {
  const pages = {};
  const currentPath = basePath ? `${basePath}/${dirName}` : dirName;
  
  // Generate content for current directory
  let content = `# ${dirName || 'Root'} Directory\n\n`;
  
  // Add navigation links if not root
  if (basePath) {
    content += `[Back to parent directory](${basePath})\n\n`;
  }

  // List subdirectories with links
  const subDirs = Object.keys(dirContent.dirs);
  if (subDirs.length > 0) {
    content += '## Subdirectories\n\n';
    subDirs.forEach(subDir => {
      content += `- [${subDir}](${currentPath}/${subDir})\n`;
    });
    content += '\n';
  }

  // Add files content
  if (dirContent.files.length > 0) {
    content += '## Files\n\n';
    dirContent.files.forEach(doc => {
      content += `### ${doc.fileName}\n\n`;
      if (Array.isArray(doc.content)) {
        doc.content.forEach(func => {
          content += `#### ${func.name}\n\n`;
          if (func.isAIGenerated) {
            content += `> *This documentation was automatically generated using AI analysis*\n\n`;
          }
          content += `${func.description}\n\n`;
          if (func.parameters?.length) {
            content += `**Parameters:**\n\n${func.parameters.map(p => `- \`${p}\``).join('\n')}\n\n`;
          }
        });
      }
    });
  }

  // Store content for current directory
  pages[currentPath] = content;

  // Process subdirectories
  Object.entries(dirContent.dirs).forEach(([subDirName, subDirContent]) => {
    if (shouldCreateSeparatePage({ files: subDirContent.files, dirs: subDirContent.dirs })) {
      const subPages = generateDirectoryWikiContent(subDirName, subDirContent, currentPath);
      Object.assign(pages, subPages);
    }
  });

  return pages;
};

// Modified publishToWiki function
const publishToWiki = async (owner, repo, documentation) => {
  const wikiPath = path.join(TEMP_DIR, `${owner}-${repo}-wiki-${Date.now()}`);
  
  try {
    logger.info('Cloning wiki repository', { owner, repo });
    await execAsync(`git clone https://github.com/${owner}/${repo}.wiki.git ${wikiPath}`);
    
    // Organize documentation by directory
    const directoryStructure = organizeFilesByDirectory(documentation);
    
    // Generate pages for directories
    const pages = generateDirectoryWikiContent('', { dirs: directoryStructure, files: [] });
    
    // Write all pages
    for (const [pagePath, content] of Object.entries(pages)) {
      const fileName = pagePath ? `${pagePath.replace(/\//g, '-')}.md` : 'Home.md';
      await fs.writeFile(path.join(wikiPath, fileName), content);
    }
    
    // Git configuration and commit
    await execAsync('git config --global user.email "auto-doc@example.com"', { cwd: wikiPath });
    await execAsync('git config --global user.name "Auto Documentation"', { cwd: wikiPath });
    
    await execAsync('git add .', { cwd: wikiPath });
    await execAsync('git commit -m "Update documentation with directory structure"', { cwd: wikiPath });
    
    // Determine the default branch
    const { stdout: branchOutput } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: wikiPath });
    const defaultBranch = branchOutput.split('/').pop().trim();
    
    await execAsync(`git push origin ${defaultBranch}`, { cwd: wikiPath });
    
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