const { MongoClient } = require('mongodb');

const uri = 'mongodb+srv://babayevvarif05:vQxHRgTnYiGc8iYJ@cvibes.3bpbz.mongodb.net/?retryWrites=true&w=majority&appName=CVibes'; // MongoDB connection string
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

let db;

async function connectToDatabase() {
    if (!db) {
        await client.connect();
        db = client.db('CVibes'); // Database name
    }
    return db;
}

module.exports = connectToDatabase;