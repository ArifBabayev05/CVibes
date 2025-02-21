const axios = require('axios');
const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const mammoth = require('mammoth');

const app = express();

// CORS configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    preflightContinue: true
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const apiKey = '6V6226aySY3BqDtPqbsasNFSb3VnHhnf';
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

// Single endpoint to handle all CV processing
app.post('/api/analyze-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!documents || !Array.isArray(documents)) {
        return res.status(400).json({ 
            error: 'Documents array is required in format: [{base64: "...", fileType: "pdf/docx/image"}]' 
        });
    }

    try {
        const processPromises = documents.map(async (doc, index) => {
            try {
                const { base64, fileType } = doc;
                
                if (!base64 || !fileType) {
                    return {
                        index,
                        status: 'error',
                        error: 'Missing base64 or fileType'
                    };
                }

                let extractedText;
                const buffer = Buffer.from(base64, 'base64');

                switch(fileType.toLowerCase()) {
                    case 'pdf':
                        const pdfData = await pdfParse(buffer);
                        extractedText = pdfData.text;
                        break;
                    case 'docx':
                        const { value } = await mammoth.extractRawText({ buffer });
                        extractedText = value;
                        break;
                    case 'png':
                    case 'jpg':
                    case 'jpeg':
                        const { data: { text } } = await Tesseract.recognize(buffer);
                        extractedText = text;
                        break;
                    default:
                        return {
                            index,
                            status: 'error',
                            error: 'Unsupported file type'
                        };
                }

                // AI Analysis with error handling
                const aiResponse = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: model,
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: extractedText
                        }
                    ]
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                // Safe parsing of AI response
                let parsedResult;
                try {
                    const aiContent = aiResponse.data.choices[0].message.content;
                    // Try to parse, if fails, return the raw content
                    parsedResult = JSON.parse(aiContent);
                } catch (parseError) {
                    console.error('JSON Parse Error:', parseError);
                    return {
                        index,
                        status: 'error',
                        error: 'Failed to parse AI response',
                        rawContent: aiResponse.data.choices[0].message.content
                    };
                }

                return {
                    index,
                    status: 'success',
                    result: parsedResult
                };

            } catch (error) {
                console.error('Processing Error:', error);
                return {
                    index,
                    status: 'error',
                    error: error.message || 'Unknown error occurred'
                };
            }
        });

        const results = await Promise.all(processPromises);
        
        res.json({
            totalProcessed: results.length,
            results: results
        });

    } catch (error) {
        console.error('Main Error:', error);
        res.status(500).json({ 
            error: error.message || 'Unknown error occurred'
        });
    }
});

// Simple health check endpoint
app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date()
    });
});

module.exports.handler = serverless(app);

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});