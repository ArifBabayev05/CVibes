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
You are an AI assistant specialized in extracting structured information from CV texts. Extract details in JSON format:
- Name, ContactInformation, Summary, Education, WorkExperience, Skills, Certifications, Languages, Projects, Achievements, OtherDetails.
If missing, use an empty string or array.
Ensure the JSON is valid and well-formatted.
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
        console.log(`Extracted Text [${index}]:`, extractedText.substring(0, 200) + '...');

        const aiResponse = await getAIResponse(extractedText);
        
        // Save the response to MongoDB with a timestamp
        const collection = db.collection('responses');
        await collection.insertOne({ 
            index, 
            status: 'success', 
            result: aiResponse, 
            createdAt: new Date() // Add the current date and time
        });

        return { index, status: 'success', result: aiResponse };
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
    try {
        const parsedContent = JSON.parse(cleanContent);
        normalizeSkills(parsedContent);
        return parsedContent;
    } catch (error) {
        throw new Error(`Failed to parse AI response: ${cleanContent}`);
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
            result: response.result
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

        res.json({ id: response._id, index: response.index, status: response.status, result: response.result });
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
            result: response.result
        }));

        res.json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Error fetching recent responses:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));