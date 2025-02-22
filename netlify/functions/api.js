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

app.use(cors({ origin: '*', methods: '*', allowedHeaders: '*', credentials: true }));
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
        const pdfDoc = await PDFDocument.load(buffer);
        return pdfDoc.getPages().map(page => page.getTextContent().then(tc => tc.items.map(i => i.str).join(' '))).join('\n');
    } catch (error) {
        console.error('Error with pdf-lib, trying OCR...', error);
        return new Promise((resolve, reject) => {
            pdfExtract(buffer, { layout: 'layout' }, (err, text) => (err ? reject(err) : resolve(text)));
        });
    }
}

async function extractTextFromDocx(buffer) {
    try {
        const doc = await docx4js.load(buffer);
        const xml = doc.content.mainDocument.xml;
        return Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('w:t')).map(n => n.textContent).join(' ');
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

module.exports.handler = serverless(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
