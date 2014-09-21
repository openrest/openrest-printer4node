var openrest = require("openrest");
var htmlToPdf = require('html-to-pdf');
var spawn = require('child_process').spawn;
var fs = require("fs");
var argv = require('minimist')(process.argv.slice(2));

var INTERVAL = 20000; // Number of ms to poll the server

var lastOrderSince = null;

htmlToPdf.setInputEncoding('UTF-8');
htmlToPdf.setOutputEncoding('UTF-8');

function showUsageAndExit() {
    console.log("Usage: --username=[username] --password=[password]");
    console.log("or Usage: --accesstoken=[facebook accesstoken]");
    process.exit(-1);
}

function exitWithError(errorMessage) {
    console.error(errorMessage);
    process.exit(-2);
}

var accessToken = null;
var roles = null;

// Build the access token based on the arguments given in the command line
if ((argv.username) && (argv.password)) {
    accessToken = "spice|"+argv.username+"|"+argv.password;
} else if (argv.accesstoken) {
    accessToken = argv.accesstoken;
} else {
    // No access token? show usage and exit
    showUsageAndExit();
}

function run() {
    console.log(" - Retrieving roles...");
    // First step, get the roles of the user to ensure the arguments were correct
    openrest.request({
        request:{type:"get_roles", accessToken:accessToken},
        callback:onGetRoles
    })
}

function onGetRoles(result) {
    // If there was an error, exit
    if (result.error) {
        exitWithError("Error logining in. Please check username and password. ["+result.errorMessage+"]");
    }

    // Check that the user has roles defined
    if ((result.value.roles || []).length === 0) {
        exitWithError("Error logining in. Please check username and password.");
    }

    console.log(" - Roles: ", result.value.roles);
    roles = result.value.roles;

    setInterval(onInterval, INTERVAL);
    onInterval();
}

function insertRoles(request) {
    var restaurantIds = [];
    var chainId = null;
    var distributorId = null;
    var admin = false;

    for (var i = 0, l = roles.length ; i < l ; i++) {
        var role = roles[i];

        switch (role.organizationType) {
            case "restaurant": restaurantIds.push(role.organizationId); break;
            case "chain" : chainId = role.organizationId; break
            case "distributor" : distributorId = role.organizationId; break;
            case "admin": admin = true; break;
        }
    }

    if (admin) {
        // Nothing to do
    } else if (distributorId) {
        request.distributorId = distributorId;
    } else if (chainId) {
        request.chainId = chainId;
    } else if (restaurantIds.length > 0) {
        request.restaurantIds = restaurantIds;
    }


}

function onInterval() {
    // TODO: Check for updates
    
    console.log(" - Checking orders.");
    var request = {
        type:"query_orders",
        accessToken:accessToken,
        status:"new",
        fields:["id", "status", "modified", "locale"],
        viewMode:"restaurant",
    };

    insertRoles(request);

    if (!lastOrderSince) {
        request.limit = 10;
    } else {
        request.since = lastOrderSince;
    }

    openrest.request({
        request:request,
        callback:function(result) {

            if (result.error) {
                console.error(result.errorMessage);
                return;
            }

            var orders = (result.value || {}).results || [];

            onOrders(orders);
        }
    })
};

function onOrders(orders) {
    console.log(" - " + orders.length + " orders found.");

    if (orders.length === 0) return;

    var requests = [];

    for (var i = 0, l = orders.length ; i < l ; i++) {
        var order = orders[i];

        if (order.modified > lastOrderSince) {
            lastOrderSince = order.modified + 1;
        }

        var req = {type:"get_order", fields:["id", "restaurantId", "html"],
            accessToken:accessToken, orderId:order.id, viewMode:"restaurant",
            anonymize:true, printCsc:false, locale:order.locale, printHeader:true,
            embed:true, printConfirmation:false
        };

        requests.push(req);

        if (argv.printWidth) {
            req.viewport = {width:parseInt(argv.printWidth), initialScale:1.0, maximumScale:1.0};
        }
    }

    openrest.request({
        request:{type:"batch", requests:requests},
        callback:function(e) {
            if (e.error) {
                console.error("[ERROR] Cannot retrieve orders: ", e.errorMessage);
                onOrders(orders); // Try again...
                return;
            }

            var responses = (e.value || {}).responses || [];

            for (var i = 0, l = responses.length ; i < l ; i++) {
                onOrder(responses[i].value)
            }
        }
    });
}

function onOrder(order) {
    var filename = "/tmp/"+order.id+".pdf";
    htmlToPdf.convertHTMLString(order.html, filename, function (error, success) {
        if (error) {
            console.error('[ERROR] Error converting html to pdf!', error);
        } else {
            if (argv.bmp) {
                onPrintBmp(filename);
            } else {
                onPrintPdf(filename);
            }
        }
    });
};

function onPrintPdf(filename) {
    spawn("lp", [filename]);
}

function onPrintBmp(filename) {
    var gs = spawn("gs", ["-dBATCH", "-dNOPAUSE", "-sDEVICE=bmpgray", "-r300", "-sOutputFile="+filename+"-%03d.bmp", filename]);

    gs.on('close', function (code, signal) {
        for (var i = 0 ; i < 100 ; i++) {
            var bmpFilename = filename+"-"+(i < 10 ? "00"+i : "0"+i)+".bmp";
            if (fs.existsSync(bmpFilename)) {
                spawn("lp", [bmpFilename]);
            }
        }
    });
    gs.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });

    gs.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
    });
}

run();
