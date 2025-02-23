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
        const results = await Promise.all(documents.map(processDocument));
        res.json({ totalProcessed: results.length, results });
    } catch (error) {
        console.error('Main Error:', error);
        res.status(500).json({ error: error.message, details: error.response?.data || 'No additional details' });
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

async function getAIResponse(text, retries = 4, delay = 1000) {
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
            await new Promise(resolve => setTimeout(resolve, delay));
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
        return JSON.parse(cleanContent);
    } catch (error) {
        throw new Error(`Failed to parse AI response: ${cleanContent}`);
    }
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

module.exports.handler = serverless(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));