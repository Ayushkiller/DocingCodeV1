import React, { useState } from "react";
import "./App.css";

function App() {
  const [repoUrl, setRepoUrl] = useState("");
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  const validateGithubUrl = (url) => {
    try {
      const githubRegex = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/;
      const match = url.match(githubRegex);
      if (!match) {
        throw new Error(
          "Invalid GitHub URL format. Please use: https://github.com/owner/repository"
        );
      }
      return {
        owner: match[1],
        repo: match[2].replace(".git", ""),
      };
    } catch (err) {
      throw new Error("Please enter a valid GitHub repository URL");
    }
  };

  const parseErrorResponse = async (response) => {
    try {
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        const data = await response.json();
        return data.message || "An error occurred while generating documentation";
      } else {
        const text = await response.text();
        return "Server error: Please try again later";
      }
    } catch (err) {
      return "Failed to process server response";
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setDocs([]);
    setProgress(0);

    try {
      const { owner, repo } = validateGithubUrl(repoUrl);

      // Make API request
      const response = await fetch(`http://localhost:5000/api/generate-docs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner,
          repo,
        }),
      });

      if (!response.ok) {
        const errorMessage = await parseErrorResponse(response);
        throw new Error(errorMessage);
      }

      // Clone the response to use for progress tracking
      const clonedResponse = response.clone();
      
      // Handle progress tracking
      const reader = clonedResponse.body.getReader();
      let receivedLength = 0;
      const contentLength = +response.headers.get("Content-Length") || 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedLength += value.length;
        if (contentLength > 0) {
          setProgress(Math.round((receivedLength / contentLength) * 100));
        }
      }

      // Use the original response for JSON parsing
      const data = await response.json();
      setDocs(data.documentation || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress(100);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>DockingCode</h1>
        <p>Generate and publish documentation from your source code</p>
      </header>

      <main>
        <form onSubmit={handleSubmit} className="input-form">
          <div className="input-wrapper">
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="Enter GitHub repository URL (e.g., https://github.com/owner/repo)"
              disabled={loading}
              required
            />
            {repoUrl && !loading && (
              <button
                type="button"
                className="clear-button"
                onClick={() => setRepoUrl("")}
              >
                ×
              </button>
            )}
          </div>
          <button type="submit" disabled={loading} className="submit-button">
            {loading ? "Generating..." : "Generate Docs"}
          </button>
        </form>

        {error && <div className="error">{error}</div>}

        {loading && (
          <div className="loading">
            <div className="loading-spinner"></div>
            <p>Analyzing repository and generating documentation...</p>
            <p>Progress: {progress}%</p>
          </div>
        )}

        {docs.length > 0 && (
          <div className="docs-section">
            <h2>Generated Documentation</h2>
            {docs.map((doc, index) => (
              <div key={index} className="doc-item">
                <h3>{doc.fileName || "Untitled Document"}</h3>
                <div className="doc-content">
                  {typeof doc.content === "object" ? (
                    <div>
                      {Array.isArray(doc.content) ? (
                        doc.content.map((func, idx) => (
                          <div key={idx} className="function-doc">
                            <h4>{func.name}</h4>
                            <p>{func.description}</p>
                            {func.parameters?.length > 0 && (
                              <div>
                                <strong>Parameters:</strong>
                                <ul>
                                  {func.parameters.map((param, paramIdx) => (
                                    <li key={paramIdx}>{param}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <>
                          <p><strong>Overview:</strong> {doc.content.overview}</p>
                          <p><strong>Content Preview:</strong> <pre>{doc.content.content}</pre></p>
                          <p><strong>Length:</strong> {doc.content.length}</p>
                        </>
                      )}
                    </div>
                  ) : (
                    <pre>{doc.content || "No content available"}</pre>
                  )}
                </div>
                {doc.wikiUrl && (
                  <div className="doc-footer">
                    <a
                      href={doc.wikiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View in Wiki →
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;