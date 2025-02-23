const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI; // MongoDB connection string
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

let db;

async function connectToDatabase() {
    if (!db) {
        await client.connect();
        db = client.db(process.env.DB_NAME); // Database name
    }
    return db;
}

module.exports = connectToDatabase;