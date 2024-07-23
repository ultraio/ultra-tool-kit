<template>
    <div class="text-3xl font-bold">Schema Validator</div>
    <br />
    <div class="grid gap-4 grid-cols-1">
        <div class="grid gap-4 grid-cols-1 text-md p-2 border rounded-md px-5 border-neutral-700">
            <div class="grid gap-px grid-rows-1"></div>
            <div class="grid grid-rows-1 gap-4">
                <div class="grid grid-cols-2 gap-4">
                    <LabelWithTooltip label="Select Schema JSON File" />
                    <input type="file" @change="onFileSelected($event)" accept=".json" capture />
                    <LabelWithTooltip label="Schema Type" />
                    <div class="flex flex-row h-12 gap-4">
                        <input type="radio" id="Factory" name="Factory" value="factory" v-model="fileType" />
                        <label class="pt-3" for="Factory">Factory</label>

                        <input type="radio" id="Uniq" name="Uniq" value="uniq" v-model="fileType" />
                        <label class="pt-3" for="Uniq">Uniq</label>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-4 py-4">
                    <span></span>
                    <Button :disabled="loading || !isFileParsed" @onClick="validateSchema">Validate</Button>
                </div>
            </div>
        </div>
        <LoadingSpinner v-if="loading"></LoadingSpinner>
    </div>
    <br />

    <!-- Schema JSON CodeBox -->
    <Expand
        v-if="isFileValidated"
        :expanded="true"
        :title="`${validationErrors ? 'Invalid Schema ❌' : 'Valid Schema ✔️'}`"
    >
        <Code :code="JSON.stringify(parsedJson)"></Code>
    </Expand>

    <br />
    <!-- Schema Error CodeBox  -->
    <Expand v-if="validationErrors" :expanded="true" title="Schema Validation Errors ❗">
        <Code :code="validationErrors"></Code>
    </Expand>

    <!-- Error Modal -->
    <ErrorModal
        title="JSON Parsing Error"
        :errorMessage="`${errorMessage}`"
        v-if="errorMessage"
        @close="() => (errorMessage = '')"
    ></ErrorModal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router/auto';
import * as I from '../../interfaces/index';
import LoadingSpinner from '../../components/widgets/LoadingSpinner.vue';
import { SchemaValidator } from '../../utilities/schemaValidator';

const route = useRoute('/schemaValidator/');
const props = defineProps<{ state: I.AuthState, metadata: I.RuntimeMetadata }>();
const emits = defineEmits<{ (e: 'transact', actions: I.Action[]): void }>();

const file = ref<any>();
const fileType = ref<'factory' | 'uniq'>('factory');
const isFileParsed = ref<boolean>(false);
const isFileValidated = ref<boolean>(false);
const parsedJson = ref<any>();
const validationErrors = ref<any>(undefined); // Used for Expanded CodeBox
const errorMessage = ref<string>(''); // Used for ErrorModal
const loading = ref<boolean>(false);

function clearError() {
    errorMessage.value = '';
    validationErrors.value = undefined;
}

const resetData = () => {
    file.value = '';
    isFileParsed.value = false;
    isFileValidated.value = false;
    parsedJson.value = undefined;
    loading.value = false;
    validationErrors.value = undefined;
    clearError();
};

const onFileSelected = (event: any) => {
    resetData();

    file.value = event.target.files[0];
    if (file.value) {
        loading.value = true;
        isFileParsed.value = false;
        parseFile();
    }
};

const parseFile = async () => {
    const fr = new FileReader();

    fr.onload = (e) => {
        if (!e.target?.result) {
            errorMessage.value = 'Failed to parse JSON file.';
        } else {
            try {
                const data = e.target.result as any;
                parsedJson.value = JSON.parse(data);
            } catch (error) {
                errorMessage.value = 'Failed to parse JSON file. Error: ' + error;
            }
        }

        loading.value = false;
        isFileParsed.value = true;
    };
    fr.readAsText(file.value);
};

const validateSchema = () => {
    loading.value = true;
    clearError();
    const { valid, errors } = SchemaValidator.validate(fileType.value, parsedJson.value);

    if (!valid) {
        validationErrors.value = JSON.stringify(errors, null, 2);
    }
    loading.value = false;
    isFileValidated.value = true;
};

onMounted(async () => {});
</script>
