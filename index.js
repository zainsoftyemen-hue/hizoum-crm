require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Database configuration
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: true, // Use true for cloud databases like Azure
        trustServerCertificate: false // Recommended to be false in production
    }
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));


// --- مسار الصفحة الرئيسية ---
// يضمن أن الطلبات إلى الرابط الرئيسي (/) تُرجع ملف index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // The connection pool is managed globally, no need to connect or close here.
        const request = new sql.Request();
        request.input('user_name', sql.NVarChar(1000), username);
        request.input('password', sql.NVarChar(1000), password);
        const result = await request.execute('sp_check_worker_user_to_login');

        if (result.recordset.length > 0) {
            return res.json({ success: true });
        } else {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
    } catch (err) {
        console.error('SQL error', err);
        return res.status(500).json({ success: false, message: 'Database error' });
    }
});

// دالة للاتصال بقاعدة البيانات
async function connectToDb() {
    try {
        await sql.connect(dbConfig);
        console.log('Connected to SQL Server successfully.');
    } catch (err) {
        console.error('Database connection failed:', err);
        // إنهاء التطبيق إذا فشل الاتصال بقاعدة البيانات
        process.exit(1);
    }
}

connectToDb();

// API Endpoint: جلب كل العملاء
app.get('/api/customers', async (req, res) => {
    // Get search term from query string, default to empty string if not provided
    const searchTerm = req.query.search || '';

    try {
        const request = new sql.Request();
        // Add the search parameter to the request
        request.input('txt_search', sql.NVarChar, searchTerm);

        // Execute the stored procedure
        const result = await request.execute('sp_search_customer_for_mangment');
        
        res.json(result.recordset);
    } catch (err) {
        console.error('Error in GET /api/customers:', err);
        res.status(500).json({ message: 'Error executing stored procedure.' });
    }
});

// API Endpoint: جلب عميل واحد بالتفصيل
app.get('/api/customers/:row', async (req, res) => {
    const { row } = req.params;
    try {
        const result = await sql.query`SELECT * FROM customer WHERE [row] = ${row}`;

        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        res.json(result.recordset[0]);
    } catch (err) {
        console.error(`Error in GET /api/customers/${row}:`, err);
        res.status(500).json({ message: 'Error fetching customer from database.' });
    }
});

// API Endpoint: إضافة عميل جديد
app.post('/api/customers', async (req, res) => {
    const { id, name, phone, email, companyName } = req.body;

    if (!id || !name) {
        return res.status(400).json({ message: 'ID and name are required.' });
    }

    try {
        // استخدام القوالب النصية الموسومة (Tagged templates) لتمرير المتغيرات بأمان (يحمي من حقن SQL)
        const result = await sql.query`
            INSERT INTO customer (id, name, phone, e_mail, company_name)
            OUTPUT INSERTED.*
            VALUES (${id}, ${name}, ${phone}, ${email}, ${companyName})
        `;
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        console.error('Error in POST /api/customers:', err);
        // التحقق من خطأ تكرار البريد الإلكتروني
        if (err.number === 2627 || err.number === 2601) {
             return res.status(409).json({ message: 'A customer with this email already exists.' });
        }
        res.status(500).json({ message: 'Error adding customer to database.' });
    }
});

// API Endpoint: تعديل بيانات عميل
app.put('/api/customers/:row', async (req, res) => {
    const { row } = req.params;
    const { id, name, email, phone, companyName } = req.body;

    if (!id || !name) {
        return res.status(400).json({ message: 'ID and name are required.' });
    }

    try {
        const result = await sql.query`
            UPDATE customer
            SET id = ${id}, name = ${name}, e_mail = ${email}, phone = ${phone}, company_name = ${companyName}
            OUTPUT INSERTED.*
            WHERE [row] = ${row}
        `;

        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        res.json(result.recordset[0]);
    } catch (err) {
        console.error(`Error in PUT /api/customers/${row}:`, err);
        // Check for duplicate email or id error
        if (err.number === 2627 || err.number === 2601) {
             return res.status(409).json({ message: 'A customer with this ID or email already exists.' });
        }
        res.status(500).json({ message: 'Error updating customer in database.' });
    }
});

// API Endpoint: حذف عميل
app.delete('/api/customers/:row', async (req, res) => {
    const { row } = req.params;
    try {
        // أولاً، احصل على معرف العميل (id) من جدول العملاء
        const customerResult = await sql.query`SELECT id FROM customer WHERE [row] = ${row}`;
        if (customerResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Customer not found.' });
        }
        const customerId = customerResult.recordset[0].id;

        // التحقق من وجود مستخدمين مرتبطين (باستخدام customer_row)
        const userCheck = await sql.query`SELECT COUNT(*) as count FROM customer_user WHERE customer_row = ${row}`;
        if (userCheck.recordset[0].count > 0) {
            return res.status(409).json({ message: 'لا يمكن حذف هذا العميل لوجود مستخدمين مرتبطين به.' });
        }

        // التحقق من وجود طلبات مرتبطة (باستخدام customer_id)
        const orderCheck = await sql.query`SELECT COUNT(*) as count FROM order_recored WHERE customer_id = ${customerId}`;
        if (orderCheck.recordset[0].count > 0) {
            return res.status(409).json({ message: 'لا يمكن حذف هذا العميل لوجود طلبات مرتبطة به.' });
        }

        // إذا لم يتم العثور على ارتباطات، قم بالحذف
        const result = await sql.query`DELETE FROM customer WHERE [row] = ${row}`;
        if (result.rowsAffected[0] === 0) {
            // هذا الشرط قد لا يتم الوصول إليه أبدًا بسبب التحقق الأول، لكنه يبقى كإجراء وقائي
            return res.status(404).json({ message: 'Customer not found.' });
        }
        res.status(200).json({ message: 'Customer deleted successfully.' });
    } catch (err) {
        console.error(`Error in DELETE /api/customers/${row}:`, err);
        // معالجة أخطاء FK إذا لم يتمكن من الحذف لأسباب أخرى في قاعدة البيانات
        if (err.number === 547) { // Foreign Key constraint violation
            return res.status(409).json({ message: 'لا يمكن حذف العميل بسبب وجود ارتباطات في جداول أخرى.' });
        }
        res.status(500).json({ message: 'Error deleting customer from database.' });
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});