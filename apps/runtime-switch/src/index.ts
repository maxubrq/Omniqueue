import {main as startProducer} from "./producer";
import {main as startConsumer} from "./consumer";

(()=>{
    const type = process.argv[2];
    if (type === "producer") {
        startProducer();
    }
    else if (type === "consumer") {
        startConsumer();
    }
    else {
        console.error("Please specify 'producer' or 'consumer' as the first argument.");
        process.exit(1);
    }
})();