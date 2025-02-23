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

const app = express();

// Configure CORS to allow requests from specific origins
const corsOptions = {
    origin: 'https://cvibes.netlify.app',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Allow OPTIONS for all routes


// JSON gövdeyi ayrıştırmak için middleware (50mb limit)
app.use(express.json({ limit: '50mb' }));

// Ortam değişkeninden API anahtarını al
const apiKey = process.env.MISTRAL_API_KEY;
const model = 'mistral-small-latest';
const systemPrompt = `
You are an AI assistant specialized in extracting structured information from CV texts. Extract details in JSON format with the following structure:
{
  "Name": "string",
  "ContactInformation": {
    "Email": "string",
    "Phone": "string",
    "Address": "string (optional)"
  },
  "Skills": ["string"],
  "WorkExperience": [
    {
      "JobTitle": "string",
      "Company": "string",
      "Duration": "string",
      "Description": "string"
    }
  ],
  "Summary": "string",
  "Education": [
    {
      "Institution": "string",
      "Degree": "string",
      "FieldOfStudy": "string",
      "Dates": "string"
    }
  ],
  "Certifications": ["string"],
  "Languages": [
    {
      "Language": "string",
      "Proficiency": "string"
    }
  ],
  "Projects": [
    {
      "name": "string",
      "description": "string"
    }
  ],
  "Achievements": ["string"]
}

Ensure the JSON is valid and well-formatted. Pay special attention to categorizing the data correctly:
- Projects should be listed under the "Projects" field, not under "Certifications".
- Each field should be filled with the appropriate data or left as an empty string or array if not available.
- If any field is missing from the CV text, assign it an empty string or an empty array as appropriate.
`;

// OPTIONS istekleri için manuel CORS preflight yanıtı
app.options('/api/analyze-cvs', (req, res) => {
    res.status(200).set({
        "Access-Control-Allow-Origin": "https://cvibes.netlify.app",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
    }).send();
});

// CV analiz endpoint'i
app.post('/api/analyze-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!Array.isArray(documents)) {
        return res.status(400).set({
            "Access-Control-Allow-Origin": "https://cvibes.netlify.app",
            "Content-Type": "application/json"
        }).json({ error: 'Invalid format: documents should be an array.' });
    }

    try {
        const results = await Promise.all(documents.map(processDocument));
        res.status(200).set({
            "Access-Control-Allow-Origin": "https://cvibes.netlify.app",
            "Content-Type": "application/json"
        }).json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Main Error:', error);
        res.status(500).set({
            "Access-Control-Allow-Origin": "https://cvibes.netlify.app",
            "Content-Type": "application/json"
        }).json({ error: error.message, details: error.response?.data || 'No additional details' });
    }
});

async function processDocument(doc, index) {
    try {
        if (!doc.base64 || !doc.fileType) {
            return { index, status: 'error', error: 'Missing base64 or fileType' };
        }

        const buffer = Buffer.from(doc.base64, 'base64');
        let extractedText = await extractText(buffer, doc.fileType);
        console.log(`Extracted Text [${index}]:`, extractedText.substring(0, 200) + '...');

        const aiResponse = await getAIResponse(extractedText);
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
        const pdfDoc = await PDFDocument.load(buffer);
        const pages = pdfDoc.getPages();
        let text = '';
        for (const page of pages) {
            text += page.getTextContent().items.map(item => item.str).join(' ');
        }
        return text;
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

async function getAIResponse(text) {
    const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ]
    }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    
    return JSON.parse(response.data.choices[0].message.content.replace(/```json\n?|```$/g, ''));
}

// Sağlık kontrol endpoint'i
app.get('/api/health', (req, res) => {
    res.status(200).set({
        "Access-Control-Allow-Origin": "https://cvibes.netlify.app",
        "Content-Type": "application/json"
    }).json({ status: 'ok', timestamp: new Date() });
});

// Netlify Function handler'ı
module.exports.handler = serverless(app);