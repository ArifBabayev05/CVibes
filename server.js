require('dotenv').config(); // Load environment variables from .env file

const axios = require('axios');
const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('xmldom');
const pdfExtract = require('pdf-text-extract');
const { PDFDocument } = require('pdf-lib');
const docx4js = require('docx4js');
const connectToDatabase = require('./db'); // Import the MongoDB connection
const { ObjectId } = require('mongodb'); // Import ObjectId

const app = express();

// Configure CORS to allow requests from any origin
app.use(cors({
    origin: '*',
    methods: 'GET,POST,PUT,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));

const apiKey = process.env.MISTRAL_API_KEY;
const model = 'mistral-small-latest';
const systemPrompt = `
You are an AI assistant specialized in extracting structured information from CV texts. Analyze the provided CV text and extract all relevant details. Your output must be a valid JSON object with the following keys:
- **Name**: The full name of the candidate.
- **ContactInformation**: All contact details such as email, phone number, address, and any other available contact info.
- **Summary**: A brief professional summary or objective, if available.
- **Education**: Details of the candidate's educational background, including institution names, degrees, fields of study, and dates.
- **WorkExperience**: Job history including job titles, company names, durations, and descriptions of responsibilities and achievements.
- **Skills**: A list of technical and soft skills mentioned.
- **Certifications**: Any certifications or licenses obtained.
- **Languages**: Languages known and proficiency levels, if available.
- **Projects**: Notable projects or portfolio items described.
- **Achievements**: Any awards, honors, or special recognitions.
- **OtherDetails**: Any additional relevant information that does not fit in the above categories.
Important:
- If any field is missing from the CV text, assign it an empty string or an empty array (for list-type fields) as appropriate.
- Ensure the JSON is well-formatted and parsable.
- Handle variations in CV formats and naming conventions gracefully.
Your task is to parse and structure the CV text completely, ensuring no important details are omitted.
`;

app.post('/api/analyze-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!Array.isArray(documents)) {
        return res.status(400).json({ error: 'Invalid format: documents should be an array.' });
    }

    try {
        const db = await connectToDatabase(); // Connect to MongoDB
        const results = await Promise.all(documents.map((doc, index) => processDocument(doc, index, db)));
        res.json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Main Error:', error);
        res.status(500).json({ error: error.message, details: error.response?.data || 'No additional details' });
    }
});

async function processDocument(doc, index, db) {
    try {
        if (!doc.base64 || !doc.fileType) {
            return { index, status: 'error', error: 'Missing base64 or fileType' };
        }

        const buffer = Buffer.from(doc.base64, 'base64');
        let extractedText = await extractText(buffer, doc.fileType);

        const aiResponse = await getAIResponse(extractedText);
        
        // Save the response to MongoDB with a timestamp
        const collection = db.collection('responses');
        await collection.insertOne({ 
            index, 
            status: 'success', 
            result: aiResponse, 
            base64: doc.base64, 
            candidateStatus: doc.candidateStatus || 'pending',
            createdAt: new Date() 
        });

        return { 
            index, 
            status: 'success', 
            result: aiResponse, 
            base64: doc.base64, 
            candidateStatus: doc.candidateStatus || 'pending' 
        };
    } catch (error) {
        console.error(`Processing Error [${index}]:`, error);
        return { index, status: 'error', error: error.message };
    }
}

async function extractText(buffer, fileType) {
    switch (fileType.toLowerCase()) {
        case 'pdf': return extractTextFromPDF(buffer);
        case 'docx': return extractTextFromDocx(buffer);
        case 'png': case 'jpg': case 'jpeg': return extractTextFromImage(buffer);
        default: throw new Error('Unsupported file type');
    }
}

async function extractTextFromPDF(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text;
    } catch (error) {
        console.error('Error extracting PDF text:', error);
        return '';
    }
}

async function extractTextFromDocx(buffer) {
    try {
        const { value } = await mammoth.extractRawText({ buffer });
        return value;
    } catch (error) {
        console.error('Error extracting DOCX text:', error);
        return '';
    }
}

async function extractTextFromImage(buffer) {
    const { data: { text } } = await Tesseract.recognize(buffer);
    return text;
}

async function getAIResponse(text, retries = 5, delay = 2000) {
    try {
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ]
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
        
        return cleanAIResponse(response.data.choices[0].message.content);
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            console.warn(`Rate limit hit, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 1000));
            return getAIResponse(text, retries - 1, delay * 2);
        } else {
            throw error;
        }
    }
}

function cleanAIResponse(responseContent) {
    let cleanContent = responseContent.trim();
    const jsonStart = cleanContent.indexOf('{');
    const jsonEnd = cleanContent.lastIndexOf('}') + 1;
    if (jsonStart !== -1 && jsonEnd !== -1) {
        cleanContent = cleanContent.substring(jsonStart, jsonEnd);
    } else {
        throw new Error(`Failed to find JSON in AI response: ${cleanContent}`);
    }

    // Replace problematic characters
    cleanContent = cleanContent.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    try {
        const parsedContent = JSON.parse(cleanContent);
        normalizeSkills(parsedContent);
        return parsedContent;
    } catch (error) {
        throw new Error(`${error} + Failed to parse AI response: ${cleanContent}`);
    }
}

function normalizeSkills(parsedContent) {
    if (parsedContent.Skills && typeof parsedContent.Skills === 'object' && !Array.isArray(parsedContent.Skills)) {
        const normalizedSkills = [];
        for (const category in parsedContent.Skills) {
            if (Array.isArray(parsedContent.Skills[category])) {
                normalizedSkills.push(...parsedContent.Skills[category]);
            }
        }
        parsedContent.Skills = normalizedSkills;
    }
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Endpoint to fetch all responses
app.get('/api/responses', async (req, res) => {
    try {
        const db = await connectToDatabase(); // Connect to MongoDB
        const collection = db.collection('responses');
        const responses = await collection.find({}).toArray();
        
        const results = responses.map(response => ({
            id: response._id,
            index: response.index,
            status: response.status,
            result: response.result,
            base64: response.base64, // Include base64 data
            candidateStatus: response.candidateStatus // Include candidate status
        }));

        res.json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Error fetching responses:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to fetch a single response by id
app.get('/api/responses/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const db = await connectToDatabase(); // Connect to MongoDB
        const collection = db.collection('responses');
        const response = await collection.findOne({ _id: new ObjectId(id) });

        if (!response) {
            return res.status(404).json({ error: 'Response not found' });
        }

        res.json({ 
            id: response._id, 
            index: response.index, 
            status: response.status, 
            result: response.result,
            base64: response.base64, // Include base64 data
            candidateStatus: response.candidateStatus // Include candidate status
        });
    } catch (error) {
        console.error(`Error fetching response [${id}]:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to fetch recent responses with a time range
app.get('/api/recent-responses', async (req, res) => {
    const { timeRange } = req.query;
    let startTime;

    switch (timeRange) {
        case 'lastHour':
            startTime = new Date(Date.now() - 60 * 60 * 1000); // Last hour
            break;
        case 'lastDay':
            startTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last day
            break;
        case 'lastWeek':
            startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Last week
            break;
        case 'lastMonth':
            startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last month
            break;
        case 'all':
        default:
            startTime = new Date(0); // All time
            break;
    }

    try {
        const db = await connectToDatabase(); // Connect to MongoDB
        const collection = db.collection('responses');
        const responses = await collection.find({ createdAt: { $gte: startTime } }).toArray();
        
        const results = responses.map(response => ({
            id: response._id,
            index: response.index,
            status: response.status,
            result: response.result,
            base64: response.base64, // Include base64 data
            candidateStatus: response.candidateStatus // Include candidate status
        }));

        res.json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Error fetching recent responses:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/match-candidates', async (req, res) => {
    const { jobDescription } = req.body;

    if (!jobDescription) {
        return res.status(400).json({ error: 'Job description is required.' });
    }

    try {
        const db = await connectToDatabase(); // Connect to MongoDB
        const collection = db.collection('responses');
        const responses = await collection.find({}).toArray();

        const candidates = responses.map(response => ({
            id: response._id,
            result: response.result,
            candidateStatus: response.candidateStatus
        }));

        const aiResponse = await getMatchingAIResponse(candidates, jobDescription);

        res.json({ matchingResults: aiResponse });
    } catch (error) {
        console.error('Error matching candidates:', error);
        res.status(500).json({ error: error.message });
    }
});

async function getMatchingAIResponse(candidates, jobDescription) {
    const prompt = `
    You are an AI assistant specialized in matching job descriptions with candidate CVs. Analyze the provided job description and the list of candidate CVs, and return a matching rate and reasons for each candidate. Your output must be a valid JSON array with the following structure:
    [
        {
            "candidateId": "candidate_id",
            "matchingRate": "matching_rate",
            "reasons": "reasons_for_matching"
        },
        ...
    ]
    Important:
    - The matching rate should be a percentage value between 0 and 100.
    - The reasons should be a brief explanation of why the candidate is suitable or not suitable for the job.
    `;

    const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
        model,
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Job Description: ${jobDescription}` },
            { role: 'user', content: `Candidates: ${JSON.stringify(candidates)}` }
        ]
    }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });

    const aiResponse = response.data.choices[0].message.content;

    // Remove any non-JSON parts from the response
    const jsonStart = aiResponse.indexOf('[');
    const jsonEnd = aiResponse.lastIndexOf(']') + 1;
    const cleanResponse = aiResponse.substring(jsonStart, jsonEnd);

    const parsedResponse = JSON.parse(cleanResponse);

    return parsedResponse; // Return the parsed JSON response
}

app.get("/auth/linkedin/token", async (req, res) => {
    const { code } = req.query;
    try {
      // Exchange code for access token
      const tokenResponse = await axios.post(
        "https://www.linkedin.com/oauth/v2/accessToken",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:8080/auth/linkedin/callback",
          client_id: "78m6kge1f5tdkb",
          client_secret: "WPL_AP1.DVVALmkLBdT3xrDH.XpbLGA==",
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
  
      const accessToken = tokenResponse.data.access_token;
      if (!accessToken) {
        throw new Error("No access token received");
      }
  
      // Fetch user data with the access token
      const userResponse = await axios.get("https://api.linkedin.com/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
  
      // Send both token and user data back to the frontend
      res.json({
        access_token: accessToken,
        user: userResponse.data,
      });
    } catch (error) {
      console.error("LinkedIn Error:", error.response?.data || error.message);
      res.status(500).json({ error: error.response?.data || "Failed to process LinkedIn request" });
    }
  });

module.exports.handler = serverless(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));